const tscreater = require('./transport/index').creater;
const proxy = require('./proxy/index');
const serializerFn = require('./serializer');
const { socks5, logger, retry, deferred } = require('@bbk47/toolbox');
const StubWorker = require('./stub/index');

const TUNNEL_CLOSE = 0;
const TUNNEL_OK = 1;

class Client {
    constructor(config) {
        this.cliOpts = config;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
            rejectUnauthorized: false,
        };
        // 内部属性
        this._streamQueue = [];
        this._tunnelStatus = TUNNEL_CLOSE;
        this._browserObjects = {};
        this.logger = logger('c>', config.logLevel || 'error', config.logFile);

        const tunopts = config.tunnelOpts;
        this.$serializer = serializerFn(tunopts.password, tunopts.method);
    }

    async setupTunnel() {
        try {
            this.logger.info('====>setuping tunnel');
            const tunnelOpts = this.cliOpts.tunnelOpts;
            this.logger.info(`create ${tunnelOpts.protocol} transport`);
            const taskfn = () => tscreater.createTransport(tunnelOpts);
            let tsport = await retry(taskfn, { times: 5, interval: 3000 });
            const stubclient = new StubWorker(tsport, this.$serializer);
            this._stubclient = stubclient;
            this.bindTunnelEvent();
        } catch (error) {
            this.logger.error(`tunnel error:${err.message}!`);
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
        this._tunnelStatus = TUNNEL_CLOSE;
    }
    handleConnClose(code) {
        this.logger.info(`tunnel closed! exit code:${code}!`);
        this._tunnelStatus = TUNNEL_CLOSE;
    }
    handleStream(stream) {
        const targetObj = this._browserObjects[stream.cid];
        targetObj && targetObj.defer.resolve(stream);
    }
    keepConnection() {
        this.checkTunnel();
        if (this._tunnelStatus === TUNNEL_OK) {
            this._stubclient.ping();
        }
    }
    async checkTunnel() {
        if (this._tunnelStatus !== TUNNEL_OK) {
            await this.setupTunnel();
            this._tunnelStatus = TUNNEL_OK;
        }
        this.flushQueue();
    }
    flushQueue() {
        while (this._streamQueue.length > 0) {
            const temp = this._streamQueue.shift();
            this._stubclient.startStream(temp.addr, (stream) => {
                temp.streamId = stream.cid;
                this._browserObjects[stream.cid] = temp;
            });
        }
    }
    awaitRequest(browserObj) {
        this._streamQueue.push(browserObj);
        this.checkTunnel();
        const timeoutPm = new Promise((resolve, reject) => {
            setTimeout(() => reject(Error(`${browserObj.remoteaddr} timeout! 30000ms exceeded!`)), 30 * 1000);
        })
        return Promise.race([browserObj.defer.promise, timeoutPm]);
    }
    handleProxyConn(isConnect, cSocket) {
        const onConnect = async  (addr, callback)=> {
            try {
                const addrInfo = socks5.parseSocks5Addr(addr);
                const remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
                const browserObj = { type: 'socks5', defer: deferred(), addr, remoteaddr };
                this.logger.info(`connecting ${browserObj.remoteaddr}!`);
                const stream = await this.awaitRequest(browserObj);
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
        }
        isConnect ? proxy.createConnectProxy(cSocket, onConnect) : proxy.createSocks5Proxy(cSocket, onConnect);
    }
    initProxyServer(host, port, isConnect) {
        const onReady = (address) => this.logger.info('proxy server listen on tcp://' + address);
        proxy.createProxyServer(host, port, this.handleProxyConn.bind(this, isConnect), onReady);
    }
    bootstrap() {
        this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenPort);
        if (this.cliOpts.listenHttpPort) {
            this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenHttpPort, true);
        }
        this.cliOpts.ping && setInterval(this.keepConnection.bind(this), 3000);
    }
}

module.exports = Client;
