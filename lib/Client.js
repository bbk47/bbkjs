const tscreater = require('./transport/index').creater;
const proxy = require('./proxy/index');
const serializerFn = require('./serializer');
const toolboxjs = require('@bbk47/toolbox');
const socks5 = toolboxjs.socks5;
const loggerFn = toolboxjs.logger;
const StubWorker = require('./stub/index');

const TUNNEL_INIT = 0;
const TUNNEL_CONNECTING = 1;
const TUNNEL_OK = 2;
const TUNNEL_DISCONNECT = 3;
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
        this._streamQueue = [];
        this._tunnelStatus = TUNNEL_INIT;
        this._browserObjects = {};
        this.logger = loggerFn('c>', config.logLevel || 'error', config.logFile);

        const tunopts = config.tunnelOpts;
        this.$serializer = serializerFn(tunopts.password, tunopts.method);
    }

    setupTunnel() {
        this.logger.info('====>setuping tunnel');
        const tunnelOpts = this.opts.tunnelOpts;
        this._tunnelStatus = TUNNEL_CONNECTING;
        const onOpen = this.handleConnOpen.bind(this);
        this.logger.info(`create ${tunnelOpts.protocol} transport`);
        let tsport = tscreater.createTransport(tunnelOpts, onOpen);
        const stubclient = new StubWorker(tsport, this.$serializer);
        stubclient.on('pong', (event) => {
            this.logger.info(`tunnel health！ up:${event.up}ms, down:${event.down}ms, rtt:${event.up + event.down}ms`);
        });
        stubclient.on('stream', this.handleStream.bind(this));
        stubclient.on('error', this.handleConnError.bind(this));
        stubclient.on('close', this.handleConnClose.bind(this));
        this._stubclient = stubclient;
    }
    handleConnOpen() {
        this.logger.info('==<<<create tunnel ok');
        this._tunnelStatus = TUNNEL_OK;
        this.requestStream();
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
        this._tunnelStatus = TUNNEL_DISCONNECT;
    }

    handleStream(stream) {
        const targetObj = this._browserObjects[stream.cid];
        if (!targetObj.onSuccess) {
            return;
        }
        targetObj.onSuccess();
        clearTimeout(targetObj.timeoutId);
        this.logger.info(`stream connect:${targetObj.remoteaddr} success`);
        // stream is ok;
        const targetSocket = targetObj.socket;
        targetSocket.pipe(stream);
        stream.pipe(targetSocket);
        targetSocket.on('close', () => stream.destroy());
        targetSocket.on('error', (err) => stream.destroy(err));
        stream.on('close', ()=>targetSocket.destroy());
        // stream.on('error', (err) => targetSocket.destroy());
    }
    handleConnClose(code) {
        this.logger.info(`tunnel closed! exit code:${code}!`);
        this._tunnelStatus = TUNNEL_INIT;
    }
    keepConnection() {
        this.checkTunnel();
        if (this._tunnelStatus === TUNNEL_OK && this._stubclient) {
            this._stubclient.ping();
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
        if (targetObj) {
            this._streamQueue.push(targetObj);
        }
        this.checkTunnel();
        if (this._tunnelStatus !== TUNNEL_OK) {
            return;
        }
        while (this._streamQueue.length > 0) {
            const temp = this._streamQueue.shift();
            this._stubclient.startStream(temp.addr, (stream) => {
                temp.streamId = stream.cid;
                this._browserObjects[stream.cid] = temp;
            });
        }
    }

    handleProxyConn(isConnect, socket) {
        const self = this;

        function onConnect(addr, callback) {
            const addrInfo = socks5.parseSocks5Addr(addr);
            const remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
            const browserObj = { type: 'socks5', socket, onSuccess: callback, addr, remoteaddr };
            self.logger.info(`connecting ${browserObj.remoteaddr}!`);
            self.requestStream(browserObj);

            browserObj.timeoutId = setTimeout(() => {
                browserObj.onSuccess = null;
                self.logger.warn(`connect ${browserObj.remoteaddr} timeout! 10000ms exceeded!`);
                callback(Error('timeout'));
            }, 30 * 1000);
        }
        isConnect ? proxy.createConnectProxy(socket, onConnect) : proxy.createSocks5Proxy(socket, onConnect);
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
