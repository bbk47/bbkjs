const net = require('net');
const server = require('./server/index');
const serializerFn = require('./serializer');
const toolboxjs = require('@bbk47/toolbox');
const socks5 = toolboxjs.socks5;
const loggerFn = toolboxjs.logger;

class Server {
    constructor(config) {
        this.opts = config;
        this.workMode = config.workMode;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
        };
        // 内部属性
        this.logger = loggerFn('s>', config.logLevel || 'error', config.logFile);
        this.$serializer = serializerFn(config.password, config.method);
    }
    initServer() {
        const params = this.opts;
        const onReady = () => {
            if (this.workMode === 'domainsocket') {
                console.log(`server listen on ${params.workMode}:${params.workPath}`);
                return;
            }
            console.log(`server listen on ${params.workMode}://${params.listenAddr}:${params.listenPort}`);
        };
        const handlers = [this.handleConnection.bind(this, this.workMode), onReady];
        if (this.workMode === 'ws') {
            server.createWsServer(params, ...handlers);
        } else if (this.workMode === 'h2') {
            server.createHttp2Server(this.tlsOpts, params, ...handlers);
        } else if (this.workMode === 'tls') {
            server.createTlsServer(this.tlsOpts, params, ...handlers);
        } else if (this.workMode === 'tcp') {
            server.createTcpServer(params, ...handlers);
        } else if (this.workMode === 'domainsocket') {
            server.createUnixsocketServer(params, ...handlers);
        } else {
            throw Error('unimplement work mode!' + this.workMode);
        }
    }
    handleConnection(type, tunconn) {
        tunconn.setSerializer(this.$serializer);
        tunconn.on('stream', this.handleStream.bind(this, tunconn));
        tunconn.on('error', this.handleConnError.bind(this, tunconn));
        tunconn.on('close', this.handleConnClose.bind(this, tunconn));
    }
    handleConnError(tunconn, err) {
        this.logger.error(`fire event[error] on client!message:${err.message}`);
    }
    handleConnClose(tunconn, code) {
        this.logger.error(`fire event[close] on client!code:${code}`);
    }
    handleStream(tunconn, stream, addrData) {
        const targetSocket = net.Socket();
        const addrInfo = socks5.parseSocks5Addr(addrData);
        this.logger.info(`REQ REQUEST ===> ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
        targetSocket.connect(addrInfo.dstPort, addrInfo.dstAddr, () => {
            this.logger.info(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            tunconn.setReady(stream);
            stream.pipe(targetSocket);
            targetSocket.pipe(stream);
        });
        targetSocket.on('close', () => stream.destroy());
        targetSocket.on('error', (err) => stream.destroy(err));
        stream.on('error', (err) => targetSocket.destroy());
    }

    bootstrap() {
        this.initServer();
    }
}

module.exports = Server;
