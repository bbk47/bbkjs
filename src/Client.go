package bbk

import (
	"bbk/src/utils"
	"fmt"
	"github.com/bbk47/toolbox"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

const (
	WEBSOCKET_INIT       uint8 = 0x0
	WEBSOCKET_CONNECTING uint8 = 0x1
	WEBSOCKET_OK         uint8 = 0x2
	WEBSOCKET_DISCONNECT uint8 = 0x3
)

const DATA_MAX_SIEZ uint16 = 1024 * 4

type Client struct {
	opts      Option
	logger    *toolbox.Logger
	serizer   *Serializer
	encryptor *toolbox.Encryptor
	// inner attr
	wsStatus       uint8           // 线程共享变量
	wsConn         *websocket.Conn //线程共享变量
	lastPong       uint64
	browserSockets map[string]net.Conn //线程共享变量
	wsLock         sync.Mutex
	bsLock         sync.Mutex
	//wsRwLock         sync.RWMutex
	//stRwLock         sync.RWMutex
	remoteFrameQueue FrameQueue
}

func NewClient(opts Option) Client {
	cli := Client{}
	cli.opts = opts
	cli.wsStatus = WEBSOCKET_INIT
	cli.browserSockets = make(map[string]net.Conn)
	cli.lastPong = uint64(time.Now().UnixNano())
	cli.remoteFrameQueue = FrameQueue{}
	serizer, _ := NewSerializer(opts.Rnglen)
	encryptor, err := toolbox.NewEncryptor(opts.Method, opts.Password)
	if err != nil {
		log.Fatalln(err)
	}
	cli.serizer = serizer
	cli.encryptor = encryptor
	return cli
}

func (client *Client) setupwsConnection() {
	if client.wsStatus == WEBSOCKET_CONNECTING || client.wsStatus == WEBSOCKET_OK {
		return
	}
	client.wsLock.Lock()
	defer client.wsLock.Unlock()
	// setup ws connection
	client.wsStatus = WEBSOCKET_CONNECTING
	wsUrl := client.opts.WebsocketUrl
	client.logger.Infof("connecting tunnel: %s\n", wsUrl)
	ws, _, err := websocket.DefaultDialer.Dial(wsUrl, nil)
	if err != nil {
		log.Fatalf("dial ws error: %v\n", err)
	}
	client.wsStatus = WEBSOCKET_OK
	client.wsConn = ws
	client.logger.Info("setup ws tunnel, start receive data ws======")
	client.flushRemoteFrame(nil)
	go func() {
		defer func() {
			ws.Close()
			client.wsStatus = WEBSOCKET_DISCONNECT
		}()

		for {
			// 接收数据
			_, data, err := ws.ReadMessage()
			//client.logger.Debugf("ws message len:%d\n", len(data))
			if err != nil {
				client.logger.Errorf("read ws data:%v\n", err)
				return
			}
			decData, err := client.encryptor.Decrypt(data)

			if err != nil {
				client.logger.Errorf("decrypt ws data:%v\n", err)
				return
			}
			respFrame, err := client.serizer.Derialize(decData)
			if err != nil {
				client.logger.Errorf("derialize: protocol error:%v\n", err)
				return
			}
			client.logger.Debugf("read. ws tunnel cid:%s, data[%d]bytes\n", respFrame.Cid, len(data))
			if respFrame.Type == PONG_FRAME {
				stByte := respFrame.Data[:13]
				atByte := respFrame.Data[13:26]
				nowst := time.Now().UnixNano() / 1e6
				st, err1 := strconv.Atoi(string(stByte))
				at, err2 := strconv.Atoi(string(atByte))

				if err1 != nil || err2 != nil {
					client.logger.Warn("invalid ping pong format")
					continue
				}
				upms := int64((at)) - int64(st)
				downms := nowst - int64(at)

				client.logger.Infof("ws tunnel health！ up:%dms, down:%dms, rtt:%dms", upms, downms, nowst-int64(st))
			} else {
				client.flushLocalFrame(respFrame)
			}

		}
	}()
}
func (client *Client) flushLocalFrame(frame *Frame) {
	client.bsLock.Lock()

	defer client.bsLock.Unlock()
	// flush local Frame
	bsocket := client.browserSockets[frame.Cid]
	//log.Println("write browser socket data:", len(frame.Data))
	if bsocket == nil {
		return
	}
	if frame.Type == STREAM_FRAME {
		client.logger.Debugf("write bs socket cid:%s, data[%d]bytes\n", frame.Cid, len(frame.Data))
		bsocket.Write(frame.Data)
	} else if frame.Type == FIN_FRAME {
		bsocket.Close()
		client.logger.Info("FIN_FRAME===close browser socket.")
	} else if frame.Type == RST_FRAME {
		client.logger.Info("RST_FRAME===close browser socket.")
		bsocket.Close()
	} else if frame.Type == EST_FRAME {
		estAddrInfo, _ := toolbox.ParseAddrInfo(frame.Data)
		client.logger.Infof("EST_FRAME connect %s:%d success.\n", estAddrInfo.Addr, estAddrInfo.Port)
	}

}

func (client *Client) flushRemoteFrame(frame *Frame) {
	queue := client.remoteFrameQueue
	if frame != nil {
		queue.Push(*frame)
	}
	//log.Println("flushRemoteFrame=======")
	client.setupwsConnection()
	if client.wsStatus != WEBSOCKET_OK {
		return
	}
	for {
		if queue.IsEmpty() {
			return
		}
		frame2 := queue.Shift()
		leng := uint16(len(frame.Data))
		if leng < DATA_MAX_SIEZ {
			client.sendRemoteFrame(frame2)
		} else {
			var offset uint16 = 0
			for {
				if offset < leng {
					frame2 := Frame{Cid: frame2.Cid, Type: frame2.Type, Data: frame2.Data[offset : offset+DATA_MAX_SIEZ]}
					offset += DATA_MAX_SIEZ
					client.sendRemoteFrame(&frame2)
				} else {
					break
				}
			}

		}
	}
}

func (client *Client) sendRemoteFrame(frame *Frame) {
	wsConn := client.wsConn
	if wsConn == nil {
		client.logger.Infof("wsConn is nil: status=%d", client.wsStatus)
	}
	if client.wsStatus == WEBSOCKET_OK {
		binaryData := client.serizer.Serialize(frame)
		encData := client.encryptor.Encrypt(binaryData)
		client.wsLock.Lock()
		client.logger.Debugf("write ws tunnel cid:%s, data[%d]bytes\n", frame.Cid, len(encData))
		wsConn.WriteMessage(websocket.BinaryMessage, encData)
		client.wsLock.Unlock()
	}
}

func (client *Client) handleConnection(conn net.Conn) {

	//log.Println("client connection come!")
	defer conn.Close()

	buf := make([]byte, 256)

	// 读取 VER 和 NMETHODS
	n, err := io.ReadFull(conn, buf[:2])
	if n != 2 || err != nil {
		client.logger.Errorf("reading ver[1], methodLen[1]: %v", err)
		return
	}

	ver, nMethods := int(buf[0]), int(buf[1])
	if ver != 5 {
		client.logger.Errorf("invalid version %d\n", ver)
		return
	}

	// 读取 METHODS 列表
	n, err = io.ReadFull(conn, buf[:nMethods])
	if n != nMethods || err != nil {
		client.logger.Error("read socks methods error:%v\n", err)
		return
	}
	//client.logger.Info("SOCKS5[INIT]===")
	// INIT
	//无需认证
	n, err = conn.Write([]byte{0x05, 0x00})
	if n != 2 || err != nil {
		client.logger.Error("write bs socks version : " + err.Error())
		return
	}

	//119 119 119 46 103 111 111 103 108 101 46 99 111 109 1 187

	n, err = io.ReadFull(conn, buf[:4])
	if err != nil {
		client.logger.Error("read exception: " + err.Error())
		return
	}
	if n != 4 {
		client.logger.Error("protol error: " + err.Error())
		return
	}

	ver, cmd, _, atyp := int(buf[0]), buf[1], buf[2], buf[3]
	if ver != 5 || cmd != 1 {
		client.logger.Error("invalid ver/cmd")
		return
	}
	addrLen := 0
	if atyp == 0x1 {
		addrLen = 7
		_, err = io.ReadFull(conn, buf[4:10])
	} else if atyp == 0x3 {
		_, err = io.ReadFull(conn, buf[4:5])
		domainLen := int(buf[4])
		addrLen = domainLen + 4
		_, err = io.ReadFull(conn, buf[5:5+domainLen+2])
	}

	if err != nil {
		client.logger.Errorf("read exception atype[%d]:%s\n", atyp, err.Error())
		return
	}

	addBuf := buf[3 : addrLen+3]

	addrInfo, err := toolbox.ParseAddrInfo(addBuf)
	if err != nil {
		client.logger.Error("parse addr info error :" + err.Error())
		return
	}
	client.logger.Infof("SOCKS5[COMMAND]===%s:%d\n", addrInfo.Addr, addrInfo.Port)

	// COMMAND RESP
	n, err = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	if err != nil {
		client.logger.Error("write bs last socks step error: " + err.Error())
		return
	}

	cid := utils.GetUUID()

	client.bsLock.Lock()
	client.browserSockets[cid] = conn
	client.bsLock.Unlock()

	startFrame := Frame{Cid: cid, Type: INIT_FRAME, Data: addBuf}

	client.flushRemoteFrame(&startFrame)
	cache := make([]byte, 1024)
	for {
		// 接收数据
		//log.Println("start read browser data<====")
		leng, err := conn.Read(cache)
		if err == io.EOF {
			// close by browser peer
			finFrame := Frame{Cid: cid, Type: FIN_FRAME, Data: []byte{0x1, 0x2}}
			client.flushRemoteFrame(&finFrame)
			return
		}
		client.logger.Debugf("read. bs socket cid:%s, data[%d]\n", cid, leng)
		//log.Println("read browser data<====", leng)
		if err != nil {
			client.logger.Errorf("read browser data:%v\n", err)
			rstFrame := Frame{Cid: cid, Type: RST_FRAME, Data: []byte{0x1, 0x2}}
			client.flushRemoteFrame(&rstFrame)
			return
		}
		streamFrame := Frame{Cid: cid, Type: STREAM_FRAME, Data: cache[:leng]}
		client.flushRemoteFrame(&streamFrame)
	}

}

func (client *Client) keepPingWs() {
	go func() {
		ticker := time.Tick(time.Second * 10)
		for range ticker {
			data := toolbox.GetNowInt64Bytes()
			pingFrame := Frame{Cid: "00000000000000000000000000000000", Type: PING_FRAME, Data: data}
			client.sendRemoteFrame(&pingFrame)
		}
	}()
}

func (client *Client) initServer() {
	opt := client.opts
	listenAddrPort := fmt.Sprintf("%s:%d", opt.ListenAddr, opt.ListenPort)
	server, err := net.Listen("tcp", listenAddrPort)
	if err != nil {
		log.Fatalf("Listen failed: %v\n", err)
	}
	client.logger.Infof("server listen on socks5://%v\n", listenAddrPort)
	for {
		conn, err := server.Accept()
		if err != nil {
			client.logger.Errorf("Accept failed: %v\n", err)
			continue
		}
		go client.handleConnection(conn)
	}
}

func (client *Client) initLogger() {
	client.logger = toolbox.Log.NewLogger(os.Stdout, "L")
	client.logger.SetLevel(client.opts.LogLevel)
}

func (client *Client) Bootstrap() {
	client.initLogger()
	client.keepPingWs()
	client.initServer()
}
