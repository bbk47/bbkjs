package server

import (
	"bbk/src/transport"
	"github.com/gorilla/websocket"
	"github.com/posener/h2conn"
	"net"
	"net/http"
)

type TunnelConn struct {
	Tuntype   string
	wSocket   *websocket.Conn
	tcpSocket net.Conn
	h2socket  *h2conn.Conn
}

func (tconn *TunnelConn) BindEvents(evts *transport.Events) {
	if tconn.Tuntype == "ws" {
		transport.BindWsSocket(tconn.wSocket, evts)
	} else if tconn.Tuntype == "tcp" || tconn.Tuntype == "tls" {
		transport.BindStreamSocket(tconn.tcpSocket, evts)
	} else {
		transport.BindH2cStreamEvents(tconn.h2socket, evts)
	}
}

func (tconn *TunnelConn) SendPacket(data []byte) (err error) {
	if tconn.Tuntype == "ws" {
		err = transport.SendWsSocket(tconn.wSocket, data)
	} else if tconn.Tuntype == "tls" || tconn.Tuntype == "tcp" {
		err = transport.SendStreamSocket(tconn.tcpSocket, data)
	} else {
		err = transport.SendHttp2Stream(tconn.h2socket, data)
	}
	return err
}

type FrameServer interface {
	ListenConn(handler func(conn *TunnelConn))
	ListenHttpConn(httpHandler func(http.ResponseWriter, *http.Request))
	GetAddr() string
}
