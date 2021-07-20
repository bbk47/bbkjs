package bbk

import (
	"bbk/src/utils"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
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

const DATA_MAX_SIEZ uint16 = 1024

type Client struct {
	opts Option

	serizer *Serializer
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
	serizer, err := NewSerializer(opts.Method, opts.Password, opts.FillByte)
	if err != nil {
		log.Fatalln(err)
	}
	cli.serizer = serizer
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
	log.Printf("connecting websocket url: %s\n", wsUrl)
	ws, _, err := websocket.DefaultDialer.Dial(wsUrl, nil)
	if err != nil {
		log.Fatal(err)
	}
	client.wsStatus = WEBSOCKET_OK
	client.wsConn = ws
	log.Println("setup ws tunnel, start receive data ws======")
	go func() {
		defer func() {
			ws.Close()
			client.wsStatus = WEBSOCKET_DISCONNECT
		}()

		for {
			// 接收数据
			_, cache, err := ws.ReadMessage()
			if err != nil {
				log.Printf("read ws data:%v\n", err)
				return
			}
			cache, err = client.serizer.ExecDecrypt(cache)
			if err != nil {
				log.Fatal("read ws data:%v\n", err)
			}
			respFrame := Derialize(cache)
			if respFrame.Type == PONG_FRAME {
				log.Println("pong======")
				stByte := respFrame.Data[:13]
				atByte := respFrame.Data[13:26]
				nowst := time.Now().UnixNano() / 1e6
				st, err := strconv.Atoi(string(stByte))
				if err != nil {
					log.Println("invalid ping pong format")
					continue
				}
				at, err := strconv.Atoi(string(atByte))
				if err != nil {
					log.Println("invalid ping pong format")
					continue
				}
				log.Printf("ws connection health！ up:%dms, down:%dms", int64((at))-int64(st), nowst-int64(at))
			} else {
				client.flushLocalFrame(respFrame)
			}

		}
	}()
}
func (client *Client) flushLocalFrame(frame Frame) {
	client.bsLock.Lock()

	defer client.bsLock.Unlock()
	// flush local Frame
	bsocket := client.browserSockets[frame.Cid]
	//log.Println("write browser socket data:", len(frame.Data))
	if bsocket == nil {
		return
	}
	if frame.Type == STREAM_FRAME {
		bsocket.Write(frame.Data)
	} else if frame.Type == FIN_FRAME {
		bsocket.Close()
		log.Println("FIN_FRAME===close browser socket.")
	} else if frame.Type == RST_FRAME {
		log.Println("RST_FRAME===close browser socket.")
		bsocket.Close()
	} else if frame.Type == EST_FRAME {
		estAddrInfo, _ := utils.ParseAddrInfo(frame.Data)
		log.Printf("EST_FRAME connect %s:%d success.\n", estAddrInfo.Addr, estAddrInfo.Port)
	}

}

func (client *Client) flushRemoteFrame(frame *Frame) {
	queue := client.remoteFrameQueue
	queue.Push(*frame)
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
			client.sendRemoteFrame(*frame2)
		} else {
			var offset uint16 = 0
			for {
				if offset < leng {
					frame2 := Frame{Cid: frame2.Cid, Type: frame2.Type, Data: frame2.Data[offset : offset+DATA_MAX_SIEZ]}
					offset += DATA_MAX_SIEZ
					client.sendRemoteFrame(frame2)
				} else {
					break
				}
			}

		}
	}
}

func (client *Client) sendRemoteFrame(frame Frame) {
	wsConn := client.wsConn
	if wsConn == nil {
		log.Println("wsConn is nil: status=", client.wsStatus)
	}
	if client.wsStatus == WEBSOCKET_OK {
		binaryData := Serialize(frame)
		binaryData = client.serizer.ExecEncrypt(binaryData)
		client.wsLock.Lock()
		//log.Println("sendRemoteFrame====", len(frame.Data))
		wsConn.WriteMessage(websocket.BinaryMessage, binaryData)
		client.wsLock.Unlock()
	}
}

func (client *Client) handleConnection(conn net.Conn) {

	//log.Println("client connection come!")
	defer conn.Close()

	buf := make([]byte, 256)

	// 读取 VER 和 NMETHODS
	n, err := io.ReadFull(conn, buf[:2])
	if n != 2 {
		log.Println("reading header: " + err.Error())
		return
	}

	ver, nMethods := int(buf[0]), int(buf[1])
	if ver != 5 {
		log.Println("invalid version")
		return
	}

	// 读取 METHODS 列表
	n, err = io.ReadFull(conn, buf[:nMethods])
	if n != nMethods {
		log.Println("reading methods: " + err.Error())
		return
	}
	log.Println("SOCKS5[INIT]===")
	// INIT
	//无需认证
	n, err = conn.Write([]byte{0x05, 0x00})
	if n != 2 || err != nil {
		log.Println("write rsp : " + err.Error())
		return
	}

	//119 119 119 46 103 111 111 103 108 101 46 99 111 109 1 187

	n, err = io.ReadFull(conn, buf[:4])
	if n != 4 {
		log.Println("protol error: " + err.Error())
		return
	}

	ver, cmd, _, atyp := int(buf[0]), buf[1], buf[2], buf[3]
	if ver != 5 || cmd != 1 {
		log.Println("invalid ver/cmd")
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

	addBuf := buf[3 : addrLen+3]

	addrInfo, err := utils.ParseAddrInfo(addBuf)
	log.Printf("SOCKS5[COMMAND]===%s:%d\n", addrInfo.Addr, addrInfo.Port)

	// COMMAND RESP
	n, err = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	if err != nil {
		log.Println("write rsp: " + err.Error())
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
			//finFrame := Frame{Cid: cid, Type: FIN_FRAME, Data: []byte{0x1, 0x2}}
			//client.flushRemoteFrame(&finFrame)
			return
		}
		//log.Println("read browser data<====", leng)
		if err != nil {
			log.Printf("read browser data:%v\n", err)
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
		ticker := time.Tick(time.Second * 5)
		for range ticker {
			data := utils.GetNowInt64Bytes()
			pingFrame := Frame{Cid: "00000000000000000000000000000000", Type: PING_FRAME, Data: data}
			client.sendRemoteFrame(pingFrame)
		}
	}()
}

func (client *Client) initialize() {
	opt := client.opts
	listenAddrPort := fmt.Sprintf("%s:%d", opt.ListenAddr, opt.ListenPort)
	server, err := net.Listen("tcp", listenAddrPort)
	if err != nil {
		log.Fatalf("Listen failed: %v\n", err)
	}
	log.Printf("server listen on socks5://%v\n", listenAddrPort)
	for {
		conn, err := server.Accept()
		if err != nil {
			log.Println("Accept failed: %v", err)
			continue
		}
		go client.handleConnection(conn)
	}
}

func (client *Client) Bootstrap() {
	client.keepPingWs()
	client.initialize()
}
