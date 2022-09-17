package proxy

import (
	"errors"
	"fmt"
	"github.com/bbk47/toolbox"
	"net"
	"net/http"
	"strings"
)

type ConnectProxy struct {
	addrBuf []byte
	conn    net.Conn
}

func (s *ConnectProxy) Read(buf []byte) (n int, err error) {
	return s.conn.Read(buf)
}
func (s *ConnectProxy) Write(buf []byte) (n int, err error) {
	return s.conn.Write(buf)
}
func (s *ConnectProxy) Close() error {
	return s.conn.Close()
}

func (s *ConnectProxy) GetAddr() []byte {
	return s.addrBuf
}

func NewConnectProxy(writer http.ResponseWriter, req *http.Request) (sss *ConnectProxy, err error) {
	sss = &ConnectProxy{}
	// 1. receive CONNECT request..
	writer.WriteHeader(http.StatusOK)
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		return nil, errors.New("Hijacking not supported")
	}
	client_conn, _, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}

	// 3. sends a HEADERS frame containing a 2xx series status code to the client, as defined in [RFC7231], Section 4.3.6
	res1 := strings.Split(req.Host, ":")
	hostname := res1[0]
	port := res1[1]

	fmt.Printf("======build socks5 packet...%s\n", req.Host)
	addr := toolbox.BuildSocks5AddrData(hostname, port)
	sss = &ConnectProxy{conn: client_conn, addrBuf: addr}
	return sss, nil
}
