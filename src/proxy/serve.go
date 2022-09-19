package proxy

import (
	"fmt"
	"net"
)

type ProxyServer struct {
	addr string
	ln   net.Listener
}

func (s *ProxyServer) ListenConn(handler func(conn net.Conn)) {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			continue
		}
		handler(conn)
	}
}
func (s *ProxyServer) GetAddr() string {
	return s.addr
}

func NewProxyServer(host string, port int) (srv *ProxyServer, err error) {
	address := fmt.Sprintf("%s:%d", host, port)
	ln, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	return &ProxyServer{ln: ln, addr: "tcp://" + address}, nil
}
