const net = require('net');
const dgram = require('dgram');
const serializerFn = require('./serializer');
const { socks5, logger } = require('@bbk47/toolbox');
const transport = require('./transport');
const serverCreater = require('./frameServer');
const StubWorker = require('./stub/index');

class Server {
    constructor(config) {
        this.opts = config;
        this.workMode = config.workMode;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
        };
        // 内部属性
        this.listenAddr = config.listenAddr;
        this.listenPort = config.listenPort;
        this.workPath = config.workPath;
        this.logger = logger('s>', config.logLevel || 'error', config.logFile);
        this.$serializer = serializerFn(config.password, config.method);
    }
    initServer() {
        const params = this.opts;
        const handlers = [this.handleConnection.bind(this, this.workMode)];
        let serve;
        if (this.workMode === 'ws') {
            serve = serverCreater.createWsServer(this.workPath, ...handlers);
        } else if (this.workMode === 'h2') {
            serve = serverCreater.createHttp2Server(this.tlsOpts, this.workPath, ...handlers);
        } else if (this.workMode === 'tls') {
            serve = serverCreater.createTlsServer(this.tlsOpts, ...handlers);
        } else if (this.workMode === 'tcp') {
            serve = serverCreater.createTcpServer(...handlers);
        } else {
            throw Error('unimplement work mode!' + this.workMode);
        }
        serve.listen(this.listenPort, this.listenAddr);
        this._server = serve;
        this.logger.info(`broker server listening on ${this.workMode}://${this.listenAddr}:${this.listenPort}${this.workPath}`);
    }
    handleConnection(type, conn) {
        const tsport = transport.wrapSocket(type, conn);
        const stubworker = new StubWorker(tsport, this.$serializer);
        stubworker.on('stream', this.handleStream.bind(this, stubworker));
        stubworker.on('udp-session', this.handleUdpSession.bind(this, stubworker));
        stubworker.on('error', this.handleConnError.bind(this, stubworker));
        stubworker.on('close', this.handleConnClose.bind(this, stubworker));
    }
    handleConnError(stubworker, err) {
        this.logger.error(`fire event[error] on client!message:${err.message}`);
    }
    handleConnClose(stubworker, code) {
        this.logger.error(`fire event[close] on client!code:${code}`);
    }
    handleStream(stubworker, stream, addrData) {
        const targetSocket = new net.Socket();
        const addrInfo = socks5.parseSocks5Addr(addrData);
        this.logger.info(`REQ REQUEST ===> ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
        targetSocket.connect(addrInfo.dstPort, addrInfo.dstAddr, () => {
            this.logger.info(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            stubworker.setReady(stream);
            stream.pipe(targetSocket);
            targetSocket.pipe(stream);
        });
        targetSocket.on('close', () => stream.destroy());
        targetSocket.on('error', (err) => stream.destroy(err));
        stream.on('error', () => targetSocket.destroy());
    }

    handleUdpSession(stubworker, cid) {
        const udpSocket = dgram.createSocket('udp4');

        stubworker.openUdpSession(cid, (addrBuf, payload) => {
            const addrInfo = socks5.parseSocks5Addr(addrBuf);
            this.logger.info(`UDP RELAY ===> ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            udpSocket.send(payload, addrInfo.dstPort, addrInfo.dstAddr, (err) => {
                if (err) this.logger.warn('udp send error: ' + err.message);
            });
        });

        udpSocket.on('message', (msg, rinfo) => {
            const addrBuf = socks5.buildSocks5Addr(rinfo.address, rinfo.port);
            stubworker.sendUdpDatagram(cid, addrBuf, msg);
        });

        udpSocket.on('error', () => {
            stubworker.closeUdpSession(cid);
        });

        // 当隧道关闭时释放 UDP socket
        stubworker.once('close', () => {
            try { udpSocket.close(); } catch (_) {}
        });
    }

    bootstrap() {
        this.initServer();
    }
}

module.exports = Server;
