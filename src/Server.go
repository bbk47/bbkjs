package bbk

import (
	"bbk/src/utils"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net"
	"net/http"
)

type Server struct {
	ListenAddr    string `json:"listenAddr"`
	ListenPort    int    `json:"listenPort"`
	FillByte      int    `json:"fillByte"`
	LogLevel      string `json:"logLevel"`
	Method        string `json:"method"`
	Password      string `json:"password"`
	WebsocketPath string `json:"websocketPath"`
}

var upgrader = websocket.Upgrader{} // use default options

func (server Server) handleConnection(w http.ResponseWriter, r *http.Request) {
	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Print("upgrade:", err)
		return
	}
	stage := "INIT"
	cache := []byte{}
	var tSocket net.Conn
	fmt.Println("client come!....")

	for {
		_, buf, err := wsConn.ReadMessage()
		if err != nil {
			log.Printf("read ws: %v\n", err)
			break
		}
		log.Printf("stage=====%s\n", stage)
		if stage == "INIT" {
			addrInfo, err := utils.ParseAddrInfo(buf)
			fmt.Printf("INIT...%s:%s\n", addrInfo.Addr, addrInfo.Port)
			if err != nil {
				log.Println("==========================================")
				return
			}
			stage = "CONNECTING"
			destAddrPort := fmt.Sprintf("%s:%d", addrInfo.Addr, addrInfo.Port)
			tSocket, err = net.Dial("tcp", destAddrPort)
			if err != nil {
				return
			}
			stage = "STREAM"
			fmt.Println("Dial OK...")
			go func() {
				defer func() {
					stage = "DESTROYED"
					defer tSocket.Close()
					return
				}()

				fmt.Println("====>START Transport data...")
				for {
					// 接收数据
					cache := make([]byte, 1024)
					len2, err := tSocket.Read(cache)
					if err == io.EOF {
						break
					}
					if err != nil {
						fmt.Printf("read target socket:%v\n", err)
						return
					}
					// 发送数据
					wsConn.WriteMessage(websocket.BinaryMessage, cache[:len2])
					fmt.Printf("send ws tunnel:%v=====\n", len2)
					if err != nil {
						fmt.Printf("send ws tunnel:%v\n", err)
						return
					}
				}
			}()
			log.Printf("after go=====stage=====%s\n", stage)
		} else if stage == "CONNECTING" {
			log.Println("append data to target cache...")
			cache = append(cache, buf...)
		} else if stage == "STREAM" {
			log.Println("write data to target socket...")
			_, err = tSocket.Write(buf)
			if err != nil {
				fmt.Printf("send target socket(stream):%v\n", err)
			}
		}

	}

}

func (server Server) initialize() error {
	localtion := fmt.Sprintf("%s:%s", server.ListenAddr, fmt.Sprintf("%v", server.ListenPort))
	http.HandleFunc(server.WebsocketPath, server.handleConnection)
	wsurl := fmt.Sprintf("%s%s%s", "ws://", localtion, server.WebsocketPath)
	log.Println("server listen on ", wsurl)
	log.Fatal(http.ListenAndServe(localtion, nil))
	return nil
}

func (server Server) Bootstrap() {
	server.initialize()
}
