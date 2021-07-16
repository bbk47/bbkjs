package bbk

import (
	"bbk/src/utils"
	"fmt"
	"github.com/gorilla/websocket"
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

func (server Server) onClose(c *websocket.Conn) {

}

func (server Server) handleConnection(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Print("upgrade:", err)
		return
	}
	defer server.onClose(c)
	stage := "INIT"
	cache := []byte{}
	var t_socket net.Conn
	for {
		_, buf, err := c.ReadMessage()
		if err != nil {
			log.Println("read:", err)
			break
		}
		if stage == "INIT" {
			addrInfo, err := utils.ParseAddrInfo(buf)
			if err != nil {
				log.Println("ignore...")
				return
			}
			stage = "CONNECTING"
			destAddrPort := fmt.Sprintf("%s:%d", addrInfo.Addr, addrInfo.Port)
			tSocket, err := net.Dial("tcp", destAddrPort)
			t_socket = tSocket
			if err != nil {
				return
			}
			defer func() {
				stage = "DESTORYED"
			}()
			stage = "STREAM"
			_, err = t_socket.Write(cache)
			if err == nil {
				cache = nil // clean cache
			}
		} else if stage == "CONNECTING" {
			cache = append(cache, buf...)
		} else if stage == "STREAM" {
			t_socket.Write(buf)
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
