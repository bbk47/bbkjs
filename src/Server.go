package bbk

import (
	"fmt"
	"github.com/bbk47/toolbox"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

var upgrader = websocket.Upgrader{} // use default options

const DATA_MAX_SIZE uint16 = 1024 * 4

const CONNECT_TIMEOUT = time.Second * 10

type Target struct {
	dataCache []byte
	status    string
	socket    net.Conn
}

type Server struct {
	opts      Option
	logger    *toolbox.Logger
	serizer   *Serializer
	encryptor *toolbox.Encryptor

	targetDict map[string]*Target
	wsLock     sync.Mutex
	tsLock     sync.Mutex
	mpLock     sync.Mutex
}

func NewServer(opt Option) Server {
	s := Server{}
	s.opts = opt
	s.targetDict = make(map[string]*Target)
	serizer, _ := NewSerializer(opt.Rnglen)

	encryptor, err := toolbox.NewEncryptor(opt.Method, opt.Password)
	if err != nil {
		log.Fatalln(err)
	}
	s.serizer = serizer
	s.encryptor = encryptor

	return s
}

func (server *Server) handleConnection(w http.ResponseWriter, r *http.Request) {
	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		server.logger.Errorf("upgrade:%v\n", err)
		return
	}
	for {
		//log.Println("check wesocket message=====")
		_, buf, err := wsConn.ReadMessage()
		if err != nil {
			server.logger.Errorf("read ws: %v\n", err)
			break
		}
		//log.Printf("websocket client message come=====length:%d\n", len(buf))
		decData, err := server.encryptor.Decrypt(buf)
		//log.Printf("websocket client message decdata=====length:%d\n", len(decData))
		if err != nil {
			server.logger.Errorf("decrypt ws data:%v\n", err)
			return
		}
		frame, err := server.serizer.Derialize(decData)
		if err != nil {
			server.logger.Errorf("derialize: protocol error:%v\n", err)
			return
		}
		server.logger.Debugf("read. ws tunnel cid:%s, data[%d]bytes\n", frame.Cid, len(buf))
		if frame.Type == PING_FRAME {
			timebs := toolbox.GetNowInt64Bytes()
			data := append(frame.Data, timebs...)
			pongFrame := Frame{Cid: "00000000000000000000000000000000", Type: PONG_FRAME, Data: data}
			server.flushResponseFrame(wsConn, &pongFrame)
		} else {
			server.dispatchRequest(wsConn, frame)
		}
	}

}

func (server *Server) dispatchRequest(clientWs *websocket.Conn, frame *Frame) {
	if frame.Type == INIT_FRAME {
		targetObj := Target{}
		targetObj.dataCache = []byte{}
		addrInfo, err := toolbox.ParseAddrInfo(frame.Data)
		if err != nil {
			server.logger.Errorf("protol error:%v\n", err)
			return
		}
		server.logger.Infof("REQ CONNECT==>%s:%d\n", addrInfo.Addr, addrInfo.Port)
		targetObj.status = "connecting"
		server.tsLock.Lock()
		server.targetDict[frame.Cid] = &targetObj
		server.tsLock.Unlock()
		go func() {
			destAddrPort := fmt.Sprintf("%s:%d", addrInfo.Addr, addrInfo.Port)
			tSocket, err := net.DialTimeout("tcp", destAddrPort, CONNECT_TIMEOUT)
			if err != nil {
				server.logger.Errorf("error:%v\n", err)
				return
			}
			targetObj.socket = tSocket
			targetObj.status = "connected"

			estFrame := Frame{Cid: frame.Cid, Type: EST_FRAME, Data: frame.Data}
			server.flushResponseFrame(clientWs, &estFrame)

			defer func() {
				targetObj.status = "destoryed"
				tSocket.Close()
			}()
			server.safeWriteSocket(&tSocket, targetObj.dataCache)
			dtlen := len(targetObj.dataCache)
			server.logger.Debugf("write rm socket cid:%s, data[%d]bytes\n", frame.Cid, frame.Cid, dtlen)
			server.logger.Infof("connect %s success. write:%d\n", destAddrPort, dtlen)
			targetObj.dataCache = nil

			for {
				//fmt.Println("====>check data from target...")
				// 接收数据
				cache := make([]byte, 1024)
				len2, err := tSocket.Read(cache)
				if err == io.EOF {
					// eof read from target socket, close by target peer
					finFrame := Frame{Cid: frame.Cid, Type: FIN_FRAME, Data: []byte{0x1, 0x2}}
					server.flushResponseFrame(clientWs, &finFrame)
					return
				}
				server.logger.Debugf("read. rm socket cid:%s, data[%d]bytes\n", frame.Cid, len2)
				if err != nil {
					server.logger.Errorf("read target socket:%v\n", err)
					rstFrame := Frame{Cid: frame.Cid, Type: RST_FRAME, Data: []byte{0x1, 0x2}}
					server.flushResponseFrame(clientWs, &rstFrame)
					return
				}

				respFrame := Frame{Cid: frame.Cid, Type: STREAM_FRAME, Data: cache[:len2]}
				server.flushResponseFrame(clientWs, &respFrame)
			}
		}()

	} else if frame.Type == STREAM_FRAME {
		//log.Printf("STREAM_FRAME=== data.length:%d\n", len(frame.Data))
		targetObj := server.resolveTarget(frame)
		if targetObj == nil {
			return
		}
		//log.Printf(" target status %s ===\n", targetObj.status)
		if targetObj.status == "connecting" {
			targetObj.dataCache = append(targetObj.dataCache, frame.Data...)
			return
		}
		if targetObj.status == "connected" {
			//log.Println("STREAM_FRAME_connected write target socket=====")
			server.safeWriteSocket(&targetObj.socket, frame.Data)
		}

	} else if frame.Type == FIN_FRAME {
		//log.Println("FIN_FRAME===")
		targetObj := server.resolveTarget(frame)
		if targetObj == nil {
			return
		}
		if targetObj.socket == nil {
			return
		}
		targetObj.socket.Close()
		targetObj.socket = nil
	}
}

func (server *Server) resolveTarget(frame *Frame) *Target {
	server.mpLock.Lock()
	defer server.mpLock.Unlock()
	targetObj := server.targetDict[frame.Cid]
	return targetObj
}

func (server *Server) safeWriteSocket(socket *net.Conn, data []byte) {
	if socket == nil {
		return
	}
	server.tsLock.Lock()
	defer server.tsLock.Unlock()
	conn := *socket
	conn.Write(data)
}

func (server *Server) sendRespFrame(ws *websocket.Conn, frame *Frame) {
	// 发送数据
	binaryData := server.serizer.Serialize(frame)
	encData := server.encryptor.Encrypt(binaryData)
	//log.Println("sendRespFrame====", len(frame.Data), len(encData), frame.Cid)
	server.wsLock.Lock()
	server.logger.Debugf("write ws tunnel cid:%s, data[%d]bytes\n", frame.Cid, len(encData))
	err := ws.WriteMessage(websocket.BinaryMessage, encData)
	server.wsLock.Unlock()
	if err != nil {
		server.logger.Errorf("send ws tunnel:%v\n", err)
		return
	}
}

func (server *Server) flushResponseFrame(ws *websocket.Conn, frame *Frame) {
	leng := uint16(len(frame.Data))

	if leng < DATA_MAX_SIEZ {
		server.sendRespFrame(ws, frame)
	} else {
		var offset uint16 = 0
		for {
			if offset < leng {
				lastOff := offset + DATA_MAX_SIZE
				last := lastOff
				if lastOff > leng {
					last = leng
				}
				frame2 := Frame{Cid: frame.Cid, Type: frame.Type, Data: frame.Data[offset:last]}
				offset = lastOff
				server.sendRespFrame(ws, &frame2)
			} else {
				break
			}
		}
	}
}
func (server *Server) initServer() error {
	opt := server.opts
	localtion := fmt.Sprintf("%s:%s", opt.ListenAddr, fmt.Sprintf("%v", opt.ListenPort))
	http.HandleFunc(opt.WebsocketPath, server.handleConnection)
	wsurl := fmt.Sprintf("%s%s%s", "ws://", localtion, opt.WebsocketPath)
	server.logger.Infof("server listen on %s\n", wsurl)
	log.Fatal(http.ListenAndServe(localtion, nil))
	return nil
}

func (server *Server) initLogger() {
	server.logger = toolbox.Log.NewLogger(os.Stdout, "S")
	server.logger.SetLevel(server.opts.LogLevel)
}

func (server *Server) Bootstrap() {
	server.initLogger()
	server.initServer()
}
