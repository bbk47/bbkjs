package bbk

import (
	"bbk/src/protocol"
	"bbk/src/transport"
	"crypto/tls"
	"fmt"
	"github.com/bbk47/toolbox"
	"github.com/gorilla/websocket"
	"github.com/posener/h2conn"
	"golang.org/x/net/http2"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
)

var upgrader = websocket.Upgrader{} // use default options

type ConnectObj struct {
	Id        string `json:"id"`
	ctype     string
	wSocket   *websocket.Conn
	tcpSocket net.Conn
	h2socket  *h2conn.Conn
	Mode      string `json:"mode"`
	Delay     int    `json:"delay"`
	Seed      string `json:"seed"`
	RemoteId  string `json:"remoteId"`
	wlock     sync.Mutex
}

func (conobj *ConnectObj) BindSocket(evts *transport.Events) {
	if conobj.ctype == "ws" {
		transport.BindWsSocket(conobj.wSocket, evts)
	} else if conobj.ctype == "tcp" || conobj.ctype == "tls" {
		transport.BindStreamSocket(conobj.tcpSocket, evts)
	} else {
		transport.BindH2cStreamEvents(conobj.h2socket, evts)
	}
}

func (conobj *ConnectObj) Write(data []byte) (err error) {
	if conobj.ctype == "ws" {
		err = transport.SendWsSocket(conobj.wSocket, data)
	} else if conobj.ctype == "tls" || conobj.ctype == "tcp" {
		err = transport.SendStreamSocket(conobj.tcpSocket, data)
	} else {
		err = transport.SendHttp2Stream(conobj.h2socket, data)
	}
	return err
}

type Target struct {
	cid       string
	dataCache chan []byte
	closed    chan uint8
	status    string
	socket    net.Conn
}

type Server struct {
	opts    Option
	logger  *toolbox.Logger
	serizer *Serializer

	connMap   sync.Map
	targetMap sync.Map

	targetDict map[string]*Target
	wsLock     sync.Mutex
	tsLock     sync.Mutex
	mpLock     sync.Mutex
}

func NewServer(opt Option) Server {
	s := Server{}
	s.opts = opt
	s.targetDict = make(map[string]*Target)

	return s
}

func (servss *Server) handleConnection(conobj *ConnectObj) {
	evts := &transport.Events{Data: make(chan []byte), Status: make(chan string)}

	go conobj.BindSocket(evts)
	if conobj.ctype == "http2" {
		servss.handleEvents(conobj, evts)
	} else {
		go servss.handleEvents(conobj, evts)
	}
}

func (servss *Server) handleEvents(connectObj *ConnectObj, evts *transport.Events) {
	servss.logger.Infof("listening %s events!\n", servss.opts.WorkMode)
	for {
		select {
		case message := <-evts.Status:
			if message == "open" {
				// send first frame
			} else if message == "close" {
				servss.releaseTunnel(connectObj)
			} else {
				// error
				servss.logger.Errorf("tunnel error:%s\n", message)
				servss.releaseTunnel(connectObj)
			}
		case packet := <-evts.Data:
			servss.logger.Debugf("receive %s packet bytes:%d\n", connectObj.Mode, len(packet))
			servss.handleConnMessage(connectObj, packet)
		}
	}
}

func (servss *Server) handleConnMessage(connectObj *ConnectObj, buf []byte) {
	//fmt.Printf("datalen:%d\n", len(buf))
	frame, err := servss.serizer.Derialize(buf)

	if err != nil {
		servss.logger.Errorf("derialize data err:%s", err.Error())
		return
	}
	servss.logger.Debugf("read. ws tunnel cid:%s, data[%d]bytes\n", frame.Cid, len(buf))
	if frame.Type == protocol.PING_FRAME {
		timebs := toolbox.GetNowInt64Bytes()
		data := append(frame.Data, timebs...)
		pongFrame := protocol.Frame{Cid: "00000000000000000000000000000000", Type: protocol.PONG_FRAME, Data: data}
		servss.flushRespFrame(connectObj, &pongFrame)
	} else {
		servss.dispatchReqFrame(connectObj, frame)
	}
}

func (servss *Server) dispatchReqFrame(connobj *ConnectObj, frame *protocol.Frame) {
	if frame.Type == protocol.INIT_FRAME {
		targetObj := Target{cid: frame.Cid}
		targetObj.dataCache = make(chan []byte, 1024*4)
		addrInfo, err := toolbox.ParseAddrInfo(frame.Data)
		if err != nil {
			servss.logger.Errorf("protol error %s", err.Error())
			return
		}
		servss.targetMap.Store(frame.Cid, &targetObj)

		servss.logger.Infof("REQ CONNECT=>%s:%d\n", addrInfo.Addr, addrInfo.Port)
		remoteAddr := fmt.Sprintf("%s:%d", addrInfo.Addr, addrInfo.Port)
		go servss.dialTcpConn(&targetObj, frame, remoteAddr, connobj)
	} else if frame.Type == protocol.STREAM_FRAME {
		//servss.logger.Info("STREAM_FRAME===")
		targetObj := servss.resolveTarget(frame.Cid)
		if targetObj == nil {
			return
		}
		targetObj.dataCache <- frame.Data
	} else if frame.Type == protocol.FIN_FRAME {
		//servss.logger.Info("FIN_FRAME===")
		targetObj := servss.resolveTarget(frame.Cid)
		if targetObj == nil || targetObj.socket == nil {
			return
		}
		socket := targetObj.socket
		socket.Close()
		servss.releaseTarget(targetObj)
	}
}

func (servss *Server) dialTcpConn(targetObj *Target, frame *protocol.Frame, remoteAddr string, connobj *ConnectObj) {
	tSocket, err := net.DialTimeout("tcp", remoteAddr, CONNECT_TIMEOUT)
	if err != nil {
		servss.logger.Errorf("dial target[%s] err:\n", remoteAddr)
		servss.logger.Errorf("%s\n", err.Error())
		return
	}
	targetObj.socket = tSocket
	targetObj.closed = make(chan uint8)
	estFrame := protocol.Frame{Cid: frame.Cid, Type: protocol.EST_FRAME, Data: frame.Data}
	servss.flushRespFrame(connobj, &estFrame)

	servss.logger.Infof("connect %s success.\n", remoteAddr)
	// receive tcp data
	go servss.receiveFromTarget(connobj, targetObj)
	// write tcp conn data
	for {
		select {
		case data := <-targetObj.dataCache:
			tSocket.Write(data)
		case <-targetObj.closed:
			return
		}
	}

}

func (servss *Server) receiveFromTarget(connobj *ConnectObj, targetobj *Target) {
	tSocket := targetobj.socket
	defer func() {
		targetobj.closed <- 1
		tSocket.Close()
		servss.releaseTarget(targetobj)
	}()
	for {
		// 接收数据
		cache := make([]byte, 1024)
		len2, err := tSocket.Read(cache)
		if err == io.EOF {
			// eof read from target socket, close by target peer
			finFrame := protocol.Frame{Cid: targetobj.cid, Type: protocol.FIN_FRAME, Data: []byte{0x1, 0x2}}
			servss.flushRespFrame(connobj, &finFrame)
			return
		}
		if err != nil {
			servss.logger.Error(err.Error())
			rstFrame := protocol.Frame{Cid: targetobj.cid, Type: protocol.RST_FRAME, Data: []byte{0x1, 0x2}}
			servss.flushRespFrame(connobj, &rstFrame)
			return
		}
		respFrame := protocol.Frame{Cid: targetobj.cid, Type: protocol.STREAM_FRAME, Data: cache[:len2]}
		servss.flushRespFrame(connobj, &respFrame)
	}
}

func (servss *Server) releaseTunnel(connectObj *ConnectObj) {
	servss.connMap.Delete(connectObj.Id)
}

func (servss *Server) resolveTunnel(tunnelId string) *ConnectObj {
	ref, ok := servss.connMap.Load(tunnelId)
	if ok == false {
		return nil
	}
	return ref.(*ConnectObj)
}

func (servss *Server) resolveTarget(frameId string) *Target {
	target, ok := servss.targetMap.Load(frameId)
	if ok == false {
		return nil
	}
	return target.(*Target)
}

func (servss *Server) releaseTarget(targetObj *Target) {
	targetObj.socket = nil
	servss.targetMap.Delete(targetObj.cid)
}

func (servss *Server) sendRespFrame(connobj *ConnectObj, frame *protocol.Frame) {

	if connobj == nil {
		return // ignore missing tunnel
	}
	// 序列化数据
	binaryData := servss.serizer.Serialize(frame)
	servss.tsLock.Lock()
	defer servss.tsLock.Unlock()
	// 发送数据
	err := connobj.Write(binaryData)
	if err != nil {
		servss.releaseTunnel(connobj)
		return
	}
}

func (servss *Server) flushRespFrame(connobj *ConnectObj, frame *protocol.Frame) {

	frames := protocol.FrameSegment(frame)
	for _, smallframe := range frames {
		servss.sendRespFrame(connobj, smallframe)
	}
}

func (servss *Server) initServer() error {
	opt := servss.opts
	localtion := fmt.Sprintf("%s:%s", opt.ListenAddr, fmt.Sprintf("%v", opt.ListenPort))
	if opt.WorkMode == "ws" {
		http.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
			writer.Write([]byte("Hello world!"))
		})
		http.HandleFunc(opt.WorkPath, func(writer http.ResponseWriter, request *http.Request) {
			wsconn, err := upgrader.Upgrade(writer, request, nil)
			if err != nil {
				servss.logger.Infof("upgrade:%s", err.Error())
				writer.Write([]byte(err.Error()))
				return
			}
			servss.handleConnection(&ConnectObj{wSocket: wsconn, ctype: "ws"})
		})
		servss.logger.Infof("servss listen on ws://127.0.0.1:%d", servss.opts.ListenPort)
		log.Fatal(http.ListenAndServe(localtion, nil))
	} else if opt.WorkMode == "tcp" {
		listener, err := net.Listen("tcp", localtion)
		if err != nil {
			servss.logger.Fatalf("Listen failed: %v\n", err)
		}
		servss.logger.Infof("servss listen on tcp://%v\n", localtion)
		for {
			conn, err := listener.Accept()
			if err != nil {
				servss.logger.Errorf("Accept failed: %v", err)
				continue
			}
			servss.handleConnection(&ConnectObj{tcpSocket: conn, ctype: "tcp"})
		}
	} else if opt.WorkMode == "tls" {
		cer, err := tls.LoadX509KeyPair(opt.SslCrt, opt.SslKey)
		if err != nil {
			servss.logger.Fatalf("load ssl certs  failed: %v\n", err)
			return err
		}
		config := &tls.Config{Certificates: []tls.Certificate{cer}}
		ln, err := tls.Listen("tcp", localtion, config)
		if err != nil {
			servss.logger.Fatalf("Listen failed: %v\n", err)
			return err
		}
		servss.logger.Infof("servss listen tls://%s\n", localtion)
		for {
			conn, err := ln.Accept()
			if err != nil {
				log.Println(err)
				continue
			}
			servss.handleConnection(&ConnectObj{tcpSocket: conn, ctype: "tls"})
		}
	} else if opt.WorkMode == "h2" {
		var srv http.Server
		srv.Addr = localtion
		http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("hello world"))
		})
		http.HandleFunc(opt.WorkPath, func(w http.ResponseWriter, r *http.Request) {
			// We only accept HTTP/2!
			// (Normally it's quite common to accept HTTP/1.- and HTTP/2 together.)
			conn, err := h2conn.Accept(w, r)
			if err != nil {
				log.Printf("Failed creating connection from %s: %s", r.RemoteAddr, err)
				http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
				return
			}
			servss.handleConnection(&ConnectObj{h2socket: conn, ctype: "http2"})
		})

		_ = http2.ConfigureServer(&srv, &http2.Server{})
		servss.logger.Infof("servss listen http2://%s\n", localtion)
		log.Fatal(srv.ListenAndServeTLS(opt.SslCrt, opt.SslKey))
	} else {
		servss.logger.Infof("unsupport work mode [%s]\n", opt.WorkMode)
	}

	return nil
}

func (servss *Server) initSerizer() {
	opt := servss.opts
	serizer, err := NewSerializer(opt.Method, opt.Password)
	if err != nil {
		servss.logger.Fatal(err)
	}
	servss.serizer = serizer

}

func (servss *Server) initLogger() {
	servss.logger = toolbox.Log.NewLogger(os.Stdout, "S")
	servss.logger.SetLevel(servss.opts.LogLevel)
}

func (servss *Server) Bootstrap() {
	servss.initLogger()
	servss.initSerizer()
	servss.initServer()
}
