package bbk

import (
	"bbk/src/utils"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"net/url"
)

type Client struct {
	ListenAddr   string `json:"listenAddr"`
	ListenPort   int    `json:"listenPort"`
	FillByte     int    `json:"fillByte"`
	LogLevel     string `json:"logLevel"`
	Method       string `json:"method"`
	Password     string `json:"password"`
	WebsocketUrl string `json:"websocketUrl"`
	Ping         bool   `json:"ping"`
}

func (client Client) handleConnection(conn net.Conn) {

	buf := make([]byte, 256)

	// 读取 VER 和 NMETHODS
	n, err := io.ReadFull(conn, buf[:2])
	if n != 2 {
		fmt.Println("reading header: " + err.Error())
		return
	}

	ver, nMethods := int(buf[0]), int(buf[1])
	if ver != 5 {
		fmt.Println("invalid version")
		return
	}

	// 读取 METHODS 列表
	n, err = io.ReadFull(conn, buf[:nMethods])
	if n != nMethods {
		fmt.Println("reading methods: " + err.Error())
		return
	}
	fmt.Println("INIT===")
	// INIT
	//无需认证
	n, err = conn.Write([]byte{0x05, 0x00})
	if n != 2 || err != nil {
		fmt.Println("write rsp : " + err.Error())
		return
	}
	fmt.Println("COMMAND===")
	//119 119 119 46 103 111 111 103 108 101 46 99 111 109 1 187

	// 读取 METHODS 列表
	n, err = io.ReadFull(conn, buf[:4])
	if n != 4 {
		fmt.Println("protol error: " + err.Error())
		return
	}

	ver, cmd, _, atyp := int(buf[0]), buf[1], buf[2], buf[3]
	if ver != 5 || cmd != 1 {
		fmt.Println("invalid ver/cmd")
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

	// ADDR
	n, err = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	if err != nil {
		fmt.Println("write rsp: " + err.Error())
	}
	fmt.Println("START_STREAM")
	// Normal TCP DATA
	//interrupt := make(chan os.Signal, 1)
	//signal.Notify(interrupt, os.Interrupt)

	u := url.URL{Scheme: "ws", Host: "127.0.0.1:5900", Path: "/websocket"}
	log.Printf("connecting to %s\n", u.String())

	wsConn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Fatal("dial:", err)
	}

	defer func() {
		log.Println("exec clean connection")
		//conn.Close()
		//wsConn.Close()
	}()

	fmt.Println("START_FRAME")

	addrinfo, err := utils.ParseAddrInfo(addBuf)

	fmt.Printf("addrInfo======>%s:%s\n", addrinfo.Addr, addrinfo.Port)

	wsConn.WriteMessage(websocket.BinaryMessage, addBuf)
	fmt.Println("write addrinfo to ws tunnel...")
	go func() {
		cache := make([]byte, 1024)
		for {
			// 接收数据

			log.Println("start read browser data<====")
			leng, err := conn.Read(cache)
			if err == io.EOF {
				break
			}
			if err != nil {
				fmt.Printf("read browser data:%v\n", err)
				return
			}
			// 发送数据
			fmt.Printf("send data（%v) to ws...\n", leng)
			wsConn.WriteMessage(websocket.BinaryMessage, cache[:leng])
			if err != nil {
				fmt.Printf("error=>send data to ws:%v\n", err)
				return
			}
		}
		fmt.Println("exec here..... wait conn=>ws data")
	}()

	log.Println("start receive data=======")
	// receive data
	for {
		// 接收数据
		leng2, cache, err := wsConn.ReadMessage()
		if err != nil {
			fmt.Printf("read ws data:%v\n", err)
			return
		}
		// 发送数据
		fmt.Printf("send data %v to browser..\n", leng2)
		conn.Write(cache)
		if err != nil {
			fmt.Printf("error=>send data to browser:%v\n", err)
			return
		}
	}

	log.Println("finish conn!")

}

func (client Client) initialize() {
	server, err := net.Listen("tcp", ":1080")
	if err != nil {
		fmt.Println("Listen failed: %v\n", err)
	}
	fmt.Println("server listen on socks5://127.0.0.1:1090")
	for {
		conn, err := server.Accept()
		if err != nil {
			fmt.Println("Accept failed: %v", err)
			continue
		}
		go client.handleConnection(conn)
	}
}

func (client Client) Bootstrap() {
	client.initialize()
}
