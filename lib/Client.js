const net = require('net');
const serializerFn = require('./serializer');
const { socks5, logger, retry, deferred, proxy } = require('@bbk47/toolbox');
const tscreater = require('./transport');
const StubWorker = require('./stub/index');

class Client {
    constructor(config) {
        this.cliOpts = config;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
            rejectUnauthorized: false,
        };
        // 内部属性
        this._browserObjects = {};
        this.logger = logger('c>', config.logLevel || 'error', config.logFile);

        const tunopts = config.tunnelOpts;
        this.$serializer = serializerFn(tunopts.password, tunopts.method);
    }

    createTransport(opts) {
        return new Promise((resolve, reject) => {
            let tsport;
            const onOpen = () => resolve(tsport);
            const protocol = opts.protocol;
            if (protocol === 'ws' || protocol === 'wss') {
                tsport = tscreater.createWebsocketTransport(opts, onOpen);
            } else if (protocol === 'h2') {
                tsport = tscreater.createHttp2Transport(opts, onOpen);
            } else if (protocol === 'tls') {
                tsport = tscreater.createTlsTransport(opts, onOpen);
            } else if (protocol === 'tcp') {
                tsport = tscreater.createTcpTransport(opts, onOpen);
            } else if (protocol === 'unix' || protocol === 'domainsocket') {
                tsport = tscreater.createUnixsocketTransport(opts, onOpen);
            } else {
                return reject(new Error('unsupport tunnel protocol:' + protocol));
            }
            // 连接建立前的失败需要让 retry 感知到（连接成功后由 StubWorker 接管错误处理）
            if (tsport && tsport.conn && typeof tsport.conn.once === 'function') {
                tsport.conn.once('error', reject);
            }
        });
    }

    async setupTunnel() {
        try {
            const tunnelOpts = this.cliOpts.tunnelOpts;
            this.logger.info(`creating ${tunnelOpts.protocol} transport`);
            const taskfn = () => this.createTransport(tunnelOpts);
            let tsport = await retry(taskfn, { times: 5, interval: 3000 });
            this._stubclient = new StubWorker(tsport, this.$serializer);
            this.bindTunnelEvent();
        } catch (error) {
            this.logger.error(`tunnel error:${error.message}!`);
            process.exit(-1);
        }
    }
    bindTunnelEvent() {
        const stubclient = this._stubclient;
        stubclient.on('pong', (event) => {
            this.logger.info(`tunnel health！ up:${event.up}ms, down:${event.down}ms, rtt:${event.up + event.down}ms`);
        });
        stubclient.on('stream', this.handleStream.bind(this));
        stubclient.on('error', this.handleConnError.bind(this));
        stubclient.on('close', this.handleConnClose.bind(this));
    }
    handleConnError(err) {
        this.logger.error(`tunnel error:${err.message}!`);
        this._tunnelReadyPm = null;
    }
    handleConnClose(code) {
        this.logger.info(`tunnel closed! exit code:${code}!`);
        this._tunnelReadyPm = null;
    }
    handleStream(stream) {
        const targetObj = this._browserObjects[stream.cid];
        targetObj && targetObj.defer.resolve(stream);
    }
    keepConnection() {
        return this.setupEnv().then(() => this._stubclient.ping());
    }
    async setupStream(browserObj) {
        await this.setupEnv();
        const stream = this._stubclient.startStream(browserObj.addr);
        this._browserObjects[stream.cid] = browserObj;
        const timeoutPm = new Promise((resolve, reject) => {
            setTimeout(() => reject(Error(`${browserObj.remoteaddr} timeout! 30000ms exceeded!`)), 30 * 1000);
        });
        return Promise.race([browserObj.defer.promise, timeoutPm]);
    }
    setupEnv() {
        if (!this._tunnelReadyPm) {
            this._tunnelReadyPm = this.setupTunnel();
        }
        return this._tunnelReadyPm;
    }
    handleProxyConn(isConnect, cSocket) {
        const onConnect = async (addr, callback) => {
            try {
                const addrInfo = socks5.parseSocks5Addr(addr);
                const remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
                const browserObj = { type: 'socks5', defer: deferred(), addr, remoteaddr };
                this.logger.info(`connecting ${browserObj.remoteaddr}!`);
                const stream = await this.setupStream(browserObj);
                callback();
                this.logger.info(`stream connect:${browserObj.remoteaddr} success`);
                cSocket.pipe(stream);
                stream.pipe(cSocket);
                cSocket.on('close', () => stream.destroy());
                cSocket.on('error', (err) => stream.destroy(err));
                stream.on('close', () => cSocket.destroy());
                // stream.on('error', (err) => cSocket.destroy());
            } catch (error) {
                this.logger.warn(error.message);
                callback(Error('timeout'));
            }
        };
        isConnect ? proxy.createConnectProxy(cSocket, onConnect) : proxy.createSocks5Proxy(cSocket, onConnect);
    }
    initProxyServer(host, port, isConnect) {
        const server = net.createServer({ allowHalfOpen: true });
        server.on('connection', this.handleProxyConn.bind(this, isConnect));
        server.listen(port, host, () => {
            this.logger.info('proxy server listen on tcp://' + host + ':' + port);
        });
    }
    bootstrap() {
        this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenPort);
        this.cliOpts.listenHttpPort && this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenHttpPort, true);
        this.cliOpts.ping && setInterval(this.keepConnection.bind(this), 3000);
    }
}

module.exports = Client;
