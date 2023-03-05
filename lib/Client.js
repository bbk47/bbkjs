const transport = require('./transport/index');
const proxy = require('./proxy/index');
const serializerFn = require('./serializer');
const toolboxjs = require('@bbk47/toolbox');
const getRandomId = toolboxjs.uuid;
const socks5 = toolboxjs.socks5;
const loggerFn = toolboxjs.logger;

const TUNNEL_INIT = 0;
const TUNNEL_CONNECTING = 1;
const TUNNEL_OK = 2;
let retryCount = 0;

class Client {
    constructor(config) {
        this.listenAddr = config.listenAddr;
        this.listenPort = config.listenPort;
        this.listenHttpPort = config.listenHttpPort;

        this.opts = config;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
            rejectUnauthorized: false,
        };
        // 内部属性
        this._remoteFrameQueue = [];
        this._streamQueue = [];
        this._tunnelStatus = TUNNEL_INIT;
        this._wsConn = null;
        this._httpConn = null;
        this._tlsConn = null;
        this._browserSockets = {};
        this.logger = loggerFn('c>', config.logLevel || 'error', config.logFile);
        this.$serializer = serializerFn(config.password, config.method);
    }

    setupTunnel() {
        this.logger.info('====>setuping tunnel');
        const tunnelOpts = this.opts.tunnelOpts;
        const params = tunnelOpts;
        this._tunnelStatus = TUNNEL_CONNECTING;
        const onReadyCb = this.handleConnOpen.bind(this);
        let tsport;
        this.logger.info(`create ${tunnelOpts.protocol} transport`);
        if (tunnelOpts.protocol === 'ws') {
            tsport = transport.createWebsocketTransport(params, onReadyCb);
        } else if (tunnelOpts.protocol === 'h2') {
            tsport = transport.createHttp2Transport(params, onReadyCb);
        } else if (tunnelOpts.protocol === 'tls') {
            tsport = transport.createTlsTransport(params, onReadyCb);
        } else if (tunnelOpts.protocol === 'tcp') {
            tsport = transport.createTcpTransport(params, onReadyCb);
        } else if (tunnelOpts.protocol === 'domainsocket') {
            tsport = transport.createUnixsocketTransport(params, onReadyCb);
        } else {
            this._tunnelStatus = TUNNEL_INIT;
            throw Error('un implement protocol!');
        }
        tsport.on('pong', event=> {
            this.logger.info(`tunnel health！ up:${event.up}ms, down:${event.down}ms, rtt:${event.up+event.down}ms`);
        });
        tsport.on('stream',this.handleStream.bind(this));
        tsport.on('error',this.handleConnError.bind(this));
        tsport.on('close',this.handleConnClose.bind(this));
        tsport.setSerializer(this.$serializer);
        this._transport = tsport;
    }
    handleConnOpen() {
        this.logger.info('==<<<create tunnel ok');
        this._tunnelStatus = TUNNEL_OK;
        retryCount = 0;
    }

    handleConnError(err) {
        this.logger.error(`tunnel error:${err.message}!`);
        if (this._tunnelStatus !== TUNNEL_OK) {
            retryCount++;
            if (retryCount > 5) {
                this.logger.error(`connect server attach max try count!`);
                process.exit(-1);
            }
        }
    }

    handleStream(stream, addr) {
        const targetObj = this._browserSockets[stream.cid];
        if (!targetObj.onSuccess) {
            return;
        }
        this.logger.info(`stream for: ${targetObj.remoteaddr} ok`);
        targetObj.onSuccess();
        // stream is ok;
        const target = this._browserSockets[stream.cid];
        const targetSocket = target.socket;
        targetSocket.pipe(stream);
        stream.pipe(targetSocket);
        targetSocket.on('close', function () {
            stream.destroy();
        });
        targetSocket.on('error', function (err) {
            stream.destroy(err);
        });
    }
    handleConnClose(code) {
        this.logger.info(`tunnel closed! exit code:${code}!`);
        this._tunnelStatus = TUNNEL_INIT;
    }
    keepConnection() {
        this.checkTunnel();
        if (this._transport) {
            this._transport.ping();
        }
    }

    checkTunnel() {
        if (this._tunnelStatus === TUNNEL_CONNECTING) {
            return;
        }
        if (this._tunnelStatus !== TUNNEL_OK) {
            this.setupTunnel();
            return;
        }
    }

    requestStream(targetObj) {
        this._streamQueue.push(targetObj);
        this.checkTunnel();
        if (this._tunnelStatus !== TUNNEL_OK) {
            return;
        }
        // console.log('====>>>>>',this._streamQueue.length);
        while (this._streamQueue.length > 0) {
            const temp = this._streamQueue.shift();
            // console.log(temp);
            this._transport.startStream(temp.id, temp.addr);
        }
    }

    handleProxyConn(isConnect, socket) {
        const self = this;
        const connectionId = getRandomId();
        const browserObj = { id: connectionId, type: 'socks5', socket };

        self._browserSockets[connectionId] = browserObj;
        var proxyEvents = [
            function onConnect(addr, callback) {
                browserObj.onSuccess = callback;
                const addrInfo = socks5.parseSocks5Addr(addr);
                browserObj.addr = addr;
                browserObj.remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
                self.logger.info(`connecting ${browserObj.remoteaddr}!`);
                self.requestStream(browserObj);

                // self.flushRemoteFrame({ cid: connectionId, type: protocol.INIT_FRAME, data: addr });
                browserObj.timeoutId = setTimeout(() => {
                    browserObj.onSuccess = null;
                    self.logger.warn(`connect ${browserObj.remoteaddr} timeout! 10000ms exceeded!`);
                    callback(Error('timeout'));
                }, 30 * 1000);
            },
            function onData(data) {
                console.log('on data=======>', data);
                // const dts =
                // self.flushRemoteFrame({ cid: connectionId, type: protocol.STREAM_FRAME, data: data });
            },
            function onClose(err, code) {
                self.logger.debug(`fire event[close] on local connection!hadError:${err ? err.message : code}`);
                // self.flushRemoteFrame({ cid: connectionId, type: protocol.FIN_FRAME, data: Buffer.from([0, 2]) });
            },
        ];
        isConnect ? proxy.createConnectProxy(socket, ...proxyEvents) : proxy.createSocks5Proxy(socket, ...proxyEvents);
    }
    initProxyServer(host, port, isConnect) {
        const onReady = (address) => this.logger.info('proxy server listen on tcp://' + address);
        proxy.createProxyServer(host, port, this.handleProxyConn.bind(this, isConnect), onReady);
    }
    bootstrap() {
        this.initProxyServer(this.listenAddr, this.listenPort);
        if (this.listenHttpPort) {
            this.initProxyServer(this.listenAddr, this.listenHttpPort, true);
        }
        this.opts.ping && setInterval(this.keepConnection.bind(this), 3000);
    }
}

module.exports = Client;
