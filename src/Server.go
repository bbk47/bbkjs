package bbk

import (
	"bbk/src/protocol"
	"bbk/src/server"
	"bbk/src/transport"
	"fmt"
	"github.com/bbk47/toolbox"
	"io"
	"net"
	"os"
	"sync"
)

type ConnectObj struct {
	Id       string `json:"id"`
	ctype    string
	tconn    *server.TunnelConn
	Mode     string `json:"mode"`
	Delay    int    `json:"delay"`
	Seed     string `json:"seed"`
	RemoteId string `json:"remoteId"`
	wlock    sync.Mutex
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

func (servss *Server) handleConnection(tunconn *server.TunnelConn) {
	evts := &transport.Events{Data: make(chan []byte), Status: make(chan string)}

	go tunconn.BindEvents(evts)
	if tunconn.Tuntype == "h2" {
		servss.handleEvents(tunconn, evts)
	} else {
		go servss.handleEvents(tunconn, evts)
	}
}

func (servss *Server) handleEvents(tunconn *server.TunnelConn, evts *transport.Events) {
	servss.logger.Infof("listening %s events!\n", servss.opts.WorkMode)
	connectObj := &ConnectObj{tconn: tunconn}
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
	err := connobj.tconn.SendPacket(binaryData)
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

func (servss *Server) initServer() {
	opt := servss.opts
	if opt.WorkMode == "tcp" {
		srv, err := server.NewAbcTcpServer(opt.ListenAddr, opt.ListenPort)
		if err != nil {
			servss.logger.Fatalf("create server failed: %v\n", err)
			return
		}
		servss.logger.Infof("servss listen tcp://%s:%d\n", opt.ListenAddr, opt.ListenPort)
		srv.ListenConn(servss.handleConnection)
	} else if opt.WorkMode == "tls" {
		srv, err := server.NewAbcTlsServer(opt.ListenAddr, opt.ListenPort, opt.SslCrt, opt.SslKey)
		if err != nil {
			servss.logger.Fatalf("create server failed: %v\n", err)
			return
		}
		servss.logger.Infof("servss listen tls://%s:%d\n", opt.ListenAddr, opt.ListenPort)
		srv.ListenConn(servss.handleConnection)
	} else if opt.WorkMode == "ws" {
		srv, err := server.NewAbcWssServer(opt.ListenAddr, opt.ListenPort, opt.WorkPath)
		if err != nil {
			servss.logger.Fatalf("create server failed: %v\n", err)
			return
		}
		servss.logger.Infof("servss listen ws://%s:%d/%s\n", opt.ListenAddr, opt.ListenPort, opt.WorkPath)
		srv.ListenConn(servss.handleConnection)
	} else if opt.WorkMode == "h2" {
		srv, err := server.NewAbcHttp2Server(opt.ListenAddr, opt.ListenPort, opt.WorkPath, opt.SslCrt, opt.SslKey)
		if err != nil {
			servss.logger.Fatalf("create server failed: %v\n", err)
			return
		}
		servss.logger.Infof("servss listen https://%s:%d/%s\n", opt.ListenAddr, opt.ListenPort, opt.WorkPath)
		srv.ListenConn(servss.handleConnection)
	} else {
		servss.logger.Infof("unsupport work mode [%s]\n", opt.WorkMode)
	}

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
