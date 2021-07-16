package bbk

import (
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"os/signal"
	"time"
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
	// INIT
	//无需认证
	n, err = conn.Write([]byte{0x05, 0x00})
	if n != 2 || err != nil {
		fmt.Println("write rsp : " + err.Error())
		return
	}
	buf2 := make([]byte, 256)

	n, err = io.ReadFull(conn, buf2[:4])
	if n != 4 || err != nil {
		fmt.Println("read header: " + err.Error())
	}

	// ADDR
	n, err = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	if err != nil {
		fmt.Println("write rsp: " + err.Error())
	}

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)

	u := url.URL{Scheme: "ws", Host: "127.0.0.1:5900", Path: "/websocket"}
	log.Printf("connecting to %s", u.String())

	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Fatal("dial:", err)
	}
	defer c.Close()
	done := make(chan struct{})

	go func() {
		defer close(done)
		for {
			_, message, err := c.ReadMessage()
			if err != nil {
				log.Println("read:", err)
				return
			}
			log.Printf("recv: %s", message)
		}
	}()

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case t := <-ticker.C:
			err := c.WriteMessage(websocket.BinaryMessage, []byte(t.String()))
			if err != nil {
				log.Println("write:", err)
				return
			}
		case <-interrupt:
			log.Println("interrupt")

			// Cleanly close the connection by sending a close message and then
			// waiting (with timeout) for the server to close the connection.
			err := c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			if err != nil {
				log.Println("write close:", err)
				return
			}
			select {
			case <-done:
			case <-time.After(time.Second):
			}
			return
		}
	}
}

func (client Client) initialize() {
	server, err := net.Listen("tcp", ":1090")
	if err != nil {
		fmt.Printf("Listen failed: %v\n", err)
	}
	fmt.Printf("server listen on socks5://127.0.0.1:1090")
	for {
		conn, err := server.Accept()
		if err != nil {
			fmt.Printf("Accept failed: %v", err)
			continue
		}
		go client.handleConnection(conn)
	}
}

func (client Client) Bootstrap() {
	client.initialize()
}
