package bbk

import (
	"bbk/src/utils"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

var upgrader = websocket.Upgrader{} // use default options

const DATA_MAX_SIZE uint16 = 1024

const CONNECT_TIMEOUT = time.Second * 10
const IO_RW_TIMEOUT = time.Second * 5

type Target struct {
	dataCache []byte
	status    string
	socket    net.Conn
}

type Server struct {
	opts          Option
	targetSockets map[string]*Target
	wsLock        sync.Mutex
	tsLock        sync.Mutex

	serizer *Serializer
}

func NewServer(opt Option) Server {
	s := Server{}
	s.opts = opt
	s.targetSockets = make(map[string]*Target)
	serizer, err := NewSerializer(opt.Method, opt.Password, opt.FillByte)
	if err != nil {
		log.Fatalln(err)
	}
	s.serizer = serizer

	return s
}

func (server *Server) handleConnection(w http.ResponseWriter, r *http.Request) {
	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Print("upgrade:", err)
		return
	}
	for {
		//log.Println("check wesocket message=====")
		_, buf, err := wsConn.ReadMessage()
		if err != nil {
			log.Printf("read ws: %v\n", err)
			break
		}
		//log.Println("websocket client message come=====")
		buf, err = server.serizer.ExecDecrypt(buf)
		frame := Derialize(buf)
		if frame.Type == PING_FRAME {
			log.Println("ping==========")
			timebs := utils.GetNowInt64Bytes()
			data := append(frame.Data, timebs...)
			pongFrame := Frame{Cid: "00000000000000000000000000000000", Type: PONG_FRAME, Data: data}
			server.flushResponseFrame(wsConn, pongFrame)
		} else {
			server.dispatchRequest(wsConn, frame)
		}
	}

}

func (server *Server) dispatchRequest(clientWs *websocket.Conn, frame Frame) {
	if frame.Type == INIT_FRAME {
		targetObj := Target{}
		targetObj.dataCache = []byte{}
		addrInfo, err := utils.ParseAddrInfo(frame.Data)
		log.Printf("REQ CONNECT==>%s:%d\n", addrInfo.Addr, addrInfo.Port)
		if err != nil {
			log.Println("==========================================")
			return
		}
		targetObj.status = "connecting"
		server.tsLock.Lock()
		server.targetSockets[frame.Cid] = &targetObj
		server.tsLock.Unlock()
		go func() {
			destAddrPort := fmt.Sprintf("%s:%d", addrInfo.Addr, addrInfo.Port)
			tSocket, err := net.DialTimeout("tcp", destAddrPort, CONNECT_TIMEOUT)
			if err != nil {
				log.Println("error:%v\n", err.Error())
				return
			}
			targetObj.socket = tSocket
			targetObj.status = "connected"

			estFrame := Frame{Cid: frame.Cid, Type: EST_FRAME, Data: frame.Data}
			server.flushResponseFrame(clientWs, estFrame)

			defer func() {
				targetObj.status = "destoryed"
				tSocket.Close()
			}()

			server.safeWriteSocket(&tSocket, targetObj.dataCache)
			targetObj.dataCache = nil
			log.Printf("connect %s success.\n", destAddrPort)

			for {
				//fmt.Println("====>check data from target...")
				// 接收数据
				cache := make([]byte, 1024)
				len2, err := tSocket.Read(cache)
				if err == io.EOF {
					// eof read from target socket, close by target peer
					finFrame := Frame{Cid: frame.Cid, Type: FIN_FRAME, Data: []byte{0x1, 0x2}}
					server.flushResponseFrame(clientWs, finFrame)
					return
				}
				//fmt.Println("====>read data target socket:", len2)
				if err != nil {
					log.Printf("read target socket:%v\n", err)
					rstFrame := Frame{Cid: frame.Cid, Type: RST_FRAME, Data: []byte{0x1, 0x2}}
					server.flushResponseFrame(clientWs, rstFrame)
					return
				}

				respFrame := Frame{Cid: frame.Cid, Type: STREAM_FRAME, Data: cache[:len2]}
				server.flushResponseFrame(clientWs, respFrame)
			}
		}()

	} else if frame.Type == STREAM_FRAME {
		//log.Println("STREAM_FRAME===")
		targetObj := server.targetSockets[frame.Cid]
		if targetObj == nil {
			return
		}
		if targetObj.status == "connecting" {
			targetObj.dataCache = append(targetObj.dataCache, frame.Data...)
			return
		}
		if targetObj.status == "connected" {
			//log.Println("STREAM_FRAME_connected write=====")
			server.safeWriteSocket(&targetObj.socket, frame.Data)
		}

	} else if frame.Type == FIN_FRAME {
		log.Println("FIN_FRAME===")
		targetObj := server.targetSockets[frame.Cid]
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

func (server *Server) safeWriteSocket(socket *net.Conn, data []byte) {
	if socket == nil {
		return
	}
	server.tsLock.Lock()
	defer server.tsLock.Unlock()
	conn := *socket
	conn.Write(data)
}

func (server *Server) sendRespFrame(ws *websocket.Conn, frame Frame) {
	// 发送数据
	binaryData := Serialize(frame)
	binaryData = server.serizer.ExecEncrypt(binaryData)
	//log.Println("sendRespFrame====", len(frame.Data))
	server.wsLock.Lock()
	err := ws.WriteMessage(websocket.BinaryMessage, binaryData)
	server.wsLock.Unlock()
	if err != nil {
		log.Printf("send ws tunnel:%v\n", err)
		return
	}
}

func (server *Server) flushResponseFrame(ws *websocket.Conn, frame Frame) {
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
				server.sendRespFrame(ws, frame2)
			} else {
				break
			}
		}
	}
}
func (server *Server) initialize() error {
	opt := server.opts
	localtion := fmt.Sprintf("%s:%s", opt.ListenAddr, fmt.Sprintf("%v", opt.ListenPort))
	http.HandleFunc(opt.WebsocketPath, server.handleConnection)
	wsurl := fmt.Sprintf("%s%s%s", "ws://", localtion, opt.WebsocketPath)
	log.Println("server listen on ", wsurl)
	log.Fatal(http.ListenAndServe(localtion, nil))
	return nil
}

func (server *Server) Bootstrap() {
	server.initialize()
}
