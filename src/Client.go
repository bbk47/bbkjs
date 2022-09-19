package bbk

import (
	"bbk/src/protocol"
	"bbk/src/proxy"
	"bbk/src/transport"
	"bbk/src/utils"
	"fmt"
	"github.com/avast/retry-go"
	"github.com/bbk47/toolbox"
	"io"
	"log"
	"net"
	"strconv"
	"sync"
	"time"
)

type BrowserObj struct {
	Cid   string `json:"cid"`
	proxy proxy.Proxy
	start chan uint8
}

type Client struct {
	opts      Option
	serizer   *Serializer
	logger    *toolbox.Logger
	tunnelOps *TunnelOpts
	// inner attr
	retryCount   uint8
	tunnelStatus uint8
	transport    transport.Transport
	lastPong     uint64
	browserProxy map[string]*BrowserObj //线程共享变量
	//tunlock          sync.Mutex
	maplock sync.RWMutex
	sendch  chan *protocol.Frame
}

func NewClient(opts Option) Client {
	cli := Client{}

	cli.opts = opts
	cli.tunnelOps = opts.TunnelOpts
	// other
	cli.tunnelStatus = TUNNEL_INIT
	cli.browserProxy = make(map[string]*BrowserObj)
	cli.lastPong = uint64(time.Now().UnixNano())
	cli.sendch = make(chan *protocol.Frame, 512)
	cli.logger = utils.NewLogger("C", opts.LogLevel)
	return cli
}

func (cli *Client) setupwsConnection() error {
	cli.logger.Infof("creating tunnel.")
	tunOpts := cli.tunnelOps
	cli.logger.Infof("creating %s tunnel\n", tunOpts.Protocol)
	err := retry.Do(
		func() error {
			tsport, err := CreateTransport(tunOpts)
			if err != nil {
				return err
			}
			cli.transport = tsport
			return nil
		},
		retry.OnRetry(func(n uint, err error) {
			cli.logger.Errorf("setup tunnel failed!%s\n", err.Error())
		}),
		retry.Attempts(5),
		retry.Delay(time.Second*5),
	)

	if err != nil {
		return err
	}

	cli.tunnelStatus = TUNNEL_OK
	cli.logger.Infof("create tunnel success!\n")
	go cli.receiveTunData()

	return nil
}

func (cli *Client) receiveTunData() {
	defer func() {
		cli.tunnelStatus = TUNNEL_DISCONNECT
	}()
	for {
		packet, err := cli.transport.ReadPacket()
		//fmt.Printf("transport read data:len:%d\n", len(packet))
		if err != nil {
			cli.logger.Infof("tunnel error event:%s.", err.Error())
			//cli.logger.Errorf("tunnel event:%v\n", message)
			cli.tunnelStatus = TUNNEL_INIT
			return
		}
		respFrame, err := cli.serizer.Derialize(packet)
		if err != nil {
			cli.logger.Errorf("protol error:%v\n", err)
			return
		}

		cli.logger.Debugf("read. ws tunnel cid:%s, data[%d]bytes\n", respFrame.Cid, len(packet))
		if respFrame.Type == protocol.PONG_FRAME {
			stByte := respFrame.Data[:13]
			atByte := respFrame.Data[13:26]
			nowst := time.Now().UnixNano() / 1e6
			st, err1 := strconv.Atoi(string(stByte))
			at, err2 := strconv.Atoi(string(atByte))

			if err1 != nil || err2 != nil {
				cli.logger.Warn("invalid ping pong format")
				continue
			}
			upms := int64((at)) - int64(st)
			downms := nowst - int64(at)

			cli.logger.Infof("ws tunnel health！ up:%dms, down:%dms, rtt:%dms", upms, downms, nowst-int64(st))
		} else {
			cli.flushLocalFrame(respFrame)
		}
	}
}

func (cli *Client) flushLocalFrame(frame *protocol.Frame) {
	// flush local Frame
	cli.maplock.RLock()
	browserobj := cli.browserProxy[frame.Cid]
	cli.maplock.RUnlock()
	cli.logger.Debugf("write browser socket data:%d\n", len(frame.Data))
	if browserobj == nil {
		return
	}
	//cli.bsLock.Lock()
	//
	//defer cli.bsLock.Unlock()

	if frame.Type == protocol.STREAM_FRAME {
		cli.logger.Debugf("write local conn frame...%s\n", frame.Cid)
		browserobj.proxy.Write(frame.Data)
	} else if frame.Type == protocol.FIN_FRAME {
		browserobj.proxy.Close()
		cli.logger.Debug("FIN_FRAME===close browser socket.")
	} else if frame.Type == protocol.RST_FRAME {
		cli.logger.Debug("RST_FRAME===close browser socket.")
		browserobj.proxy.Close()
	} else if frame.Type == protocol.EST_FRAME {
		estAddrInfo, _ := toolbox.ParseAddrInfo(frame.Data)
		cli.logger.Infof("EST_FRAME connect %s:%d success.\n", estAddrInfo.Addr, estAddrInfo.Port)
		browserobj.start <- 1
	}

}

func (cli *Client) serviceWorker() {
	go func() {
		for {
			select {
			case ref := <-cli.sendch:
				cli.sendRemoteFrame(ref)
			}
		}
	}()
}
func (cli *Client) resetSockets() {
	cli.logger.Info("==== reset browser sockets ====")
	keys := make([]string, len(cli.browserProxy))
	j := 0
	for k := range cli.browserProxy {
		keys[j] = k
		j++
	}
	cli.maplock.Lock()
	for _, value := range keys {
		browserobj := cli.browserProxy[value]
		browserobj.proxy.Close()
		delete(cli.browserProxy, value)
	}
	cli.maplock.Unlock()
}

func (cli *Client) flushRemoteFrame(frame *protocol.Frame) {
	cli.sendch <- frame
}

func (cli *Client) sendRemoteFrame(frame *protocol.Frame) {
	//fmt.Println("=====flushRemoteFrame2====")
	//cli.tunlock.Lock()
	//defer cli.tunlock.Unlock()
	if cli.tunnelStatus != TUNNEL_OK {
		err := cli.setupwsConnection()
		if err != nil {
			log.Fatal(err)
			return
		}
		cli.resetSockets()
	}

	cli.logger.Debugf("send remote frame. type:%d\n", frame.Type)
	frames := protocol.FrameSegment(frame)
	for _, smallframe := range frames {
		binaryData := cli.serizer.Serialize(smallframe)
		err := cli.transport.Send(binaryData)
		if err != nil {
			cli.logger.Errorf("send remote frame err:%s\n", err.Error())
			cli.tunnelStatus = TUNNEL_DISCONNECT
		}
	}

}

func (cli *Client) bindProxySocket(proxysvc proxy.Proxy) {
	defer proxysvc.Close()

	addrInfo, err := toolbox.ParseAddrInfo(proxysvc.GetAddr())
	if err != nil {
		cli.logger.Infof("prase addr info err:%s\n", err.Error())
		return
	}
	remoteaddr := fmt.Sprintf("%s:%d", addrInfo.Addr, addrInfo.Port)
	cli.logger.Infof("COMMAND===%s\n", remoteaddr)

	cid := utils.GetUUID()
	newbrowserobj := &BrowserObj{proxy: proxysvc, start: make(chan uint8), Cid: cid}
	cli.maplock.Lock()
	cli.browserProxy[cid] = newbrowserobj
	cli.maplock.Unlock()

	defer func() {
		cli.maplock.Lock()
		delete(cli.browserProxy, cid)
		cli.maplock.Unlock()
	}()
	startFrame := protocol.Frame{Cid: cid, Type: protocol.INIT_FRAME, Data: proxysvc.GetAddr()}
	cli.flushRemoteFrame(&startFrame)

	select {
	case <-newbrowserobj.start: // 收到信号才开始读
		cli.readBrowserSocket(newbrowserobj)
	case <-time.After(10 * time.Second):
		cli.logger.Warnf("connect %s timeout 10000ms exceeded!", remoteaddr)
	}
}
func (cli *Client) readBrowserSocket(browserobj *BrowserObj) {

	cache := make([]byte, 1024)
	for {
		// 接收数据
		//log.Println("start read browser data<====")
		leng, err := browserobj.proxy.Read(cache)
		if err == io.EOF {
			// close by browser peer
			cli.logger.Info("proxy browser socket close by peer.")
			rstFrame := protocol.Frame{Cid: browserobj.Cid, Type: protocol.FIN_FRAME, Data: []byte{0x1, 0x1}}
			cli.flushRemoteFrame(&rstFrame)
			return
		}
		//log.Println("read browser data<====", leng)
		if err != nil {
			cli.logger.Error(err.Error())
			rstFrame := protocol.Frame{Cid: browserobj.Cid, Type: protocol.RST_FRAME, Data: []byte{0x1, 0x2}}
			cli.flushRemoteFrame(&rstFrame)
			return
		}
		sdata := make([]byte, leng)
		copy(sdata, cache[:leng])
		streamFrame := protocol.Frame{Cid: browserobj.Cid, Type: protocol.STREAM_FRAME, Data: sdata}
		cli.flushRemoteFrame(&streamFrame)
	}
}

func (client *Client) keepPingWs() {
	go func() {
		ticker := time.Tick(time.Second * 10)
		for range ticker {
			data := toolbox.GetNowInt64Bytes()
			pingFrame := protocol.Frame{Cid: "00000000000000000000000000000000", Type: protocol.PING_FRAME, Data: data}
			client.sendRemoteFrame(&pingFrame)
		}
	}()
}

func (cli *Client) initProxyServer(port int, isConnect bool) {
	srv, err := proxy.NewProxyServer(cli.opts.ListenAddr, port)
	if err != nil {
		cli.logger.Fatalf("Listen failed: %v\n", err)
		return
	}
	cli.logger.Infof("proxy server listen on %s\n", srv.GetAddr())
	srv.ListenConn(func(conn net.Conn) {
		go func() {
			var proxyConn proxy.Proxy
			var err error
			if isConnect == true {
				proxyConn, err = proxy.NewConnectProxy(conn)
			} else {
				proxyConn, err = proxy.NewSocks5Proxy(conn)
			}
			if err != nil {
				cli.logger.Errorf("create proxy err:%s\n", err.Error())
				return
			}
			cli.bindProxySocket(proxyConn)
		}()
	})
}

func (cli *Client) initServer() {
	opt := cli.opts
	if opt.ListenHttpPort > 1080 {
		go cli.initProxyServer(opt.ListenHttpPort, true)
	}
	cli.initProxyServer(opt.ListenPort, false)
}

func (cli *Client) initSerizer() {
	serizer, err := NewSerializer(cli.tunnelOps.Method, cli.tunnelOps.Password)
	if err != nil {
		cli.logger.Fatal(err)
	}
	cli.serizer = serizer
}

func (cli *Client) Bootstrap() {
	cli.initSerizer()
	cli.keepPingWs()
	cli.serviceWorker()
	cli.initServer()
}
