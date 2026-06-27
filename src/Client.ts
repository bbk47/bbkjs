import * as net from 'net';
import * as dgram from 'dgram';
import { socks5, logger, retry, proxy } from '@bbk47/toolbox';
import type { Logger } from '@bbk47/toolbox';
import { dialRawCarrier } from './transport';
import { SecureConn, Session } from './tunnel';
import type { TunnelStream } from './tunnel';
import { relay } from './utils';
import { clientUDP, udpMarkerAddr } from './proxy/udp';
import type { AppOptions } from './option';

class Client {
    private cliOpts: AppOptions;
    private logger: Logger;
    private session?: Session;
    private settingUp?: Promise<Session>;
    _proxyServers?: net.Server[];

    constructor(config: AppOptions) {
        this.cliOpts = config;
        this.logger = logger('c>', (config.logLevel as Parameters<typeof logger>[1]) || 'error', config.logFile);
    }

    // setupTunnel 建立一条隧道会话：裸连接 -> 整流加密 -> yamux 复用。失败按固定次数/间隔重试。
    private async setupTunnel(): Promise<Session> {
        const tun = this.cliOpts.tunnelOpts;
        this.logger.info(`creating ${tun.protocol} tunnel`);
        const task = async (): Promise<Session> => {
            const raw = await dialRawCarrier(tun);
            let secure: SecureConn;
            try {
                secure = await SecureConn.clientSecure(raw, tun.method, tun.password);
            } catch (err) {
                raw.destroy();
                throw err;
            }
            return new Session(secure, false);
        };
        const sess = await retry(task, { times: 5, interval: 5000 });
        this.logger.info('create tunnel success!');
        return sess;
    }

    // getSession 返回当前可用会话；若不存在或已关闭则重建。
    // yamux 自带 keepalive，断链会使会话进入 closed，从而在此触发重连。
    getSession(): Promise<Session> {
        if (this.session && !this.session.isClosed()) {
            return Promise.resolve(this.session);
        }
        if (!this.settingUp) {
            this.settingUp = this.setupTunnel()
                .then((sess) => {
                    this.session = sess;
                    this.settingUp = undefined;
                    sess.on('error', (err: Error) => this.logger.error(`tunnel error:${err.message}!`));
                    return sess;
                })
                .catch((err) => {
                    this.settingUp = undefined;
                    throw err;
                });
        }
        return this.settingUp;
    }

    // setupEnv 预热/复用隧道会话（供测试与 keepalive 复用）。
    setupEnv(): Promise<void> {
        return this.getSession().then(() => undefined);
    }

    private async onConnect(cSocket: net.Socket, addr: Buffer, callback: (err?: Error | null) => void): Promise<void> {
        const addrInfo = socks5.parseSocks5Addr(addr);
        const remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
        this.logger.info(`COMMAND===${remoteaddr}`);
        try {
            const sess = await this.getSession();
            const stream = await sess.openStream(addr);
            callback();
            this.logger.info(`EST success:${remoteaddr}`);
            relay(cSocket, stream, this.logger);
        } catch (err) {
            this.logger.warn(`open stream ${remoteaddr} err:${(err as Error).message}`);
            callback(new Error('connect failed'));
        }
    }

    // 注意：必须同步执行(不能 async/await 在前)，因为 toolbox 在 bind relay socket
    // 后会立即回 app UDP ASSOCIATE 响应，app 随即可能发数据报。clientUDP 需要在本
    // 同步阶段就挂上 udpSocket 的 'message' 监听，否则隧道流建立的网络往返期间到达
    // 的数据报会被 Node dgram 丢弃。隧道流以 Promise 形式传入，由 clientUDP 缓存早
    // 到的数据报、待流就绪后回放。
    private onUdpAssociate(udpSocket: dgram.Socket, ctrlSocket: net.Socket): void {
        const streamP: Promise<TunnelStream> = this.getSession().then((sess) => sess.openStream(udpMarkerAddr()));
        // 流建立失败不应作为未处理拒绝；clientUDP 已订阅该 Promise 处理失败，这里
        // 额外吞掉以避免 UnhandledPromiseRejection。
        streamP.catch(() => undefined);

        clientUDP(udpSocket, streamP, this.logger);

        // SOCKS5 规定：控制 TCP 连接关闭即代表 UDP 关联结束。
        // 注意：代理 server 开了 allowHalfOpen，对端 FIN 只触发 'end' 而非 'close'，
        // 必须一并监听 'end'，否则 FIN 关闭时整条 UDP 关联（mux 流 + 两侧 socket +
        // server 空闲定时器）都不会被释放，造成资源泄漏。
        const endAssociate = () => {
            streamP.then((s) => s.destroy()).catch(() => undefined);
            ctrlSocket.destroy();
        };
        ctrlSocket.on('end', endAssociate);
        ctrlSocket.on('close', endAssociate);
        ctrlSocket.on('error', endAssociate);
    }

    private handleProxyConn(isConnect: boolean, cSocket: net.Socket): void {
        const onConnect = (addr: Buffer, callback: (err?: Error | null) => void) => {
            void this.onConnect(cSocket, addr, callback);
        };
        if (isConnect) {
            proxy.createConnectProxy(cSocket, onConnect);
        } else {
            proxy.createSocks5Proxy(cSocket, onConnect, (udpSocket, ctrlSocket) => {
                this.onUdpAssociate(udpSocket, ctrlSocket);
            });
        }
    }

    private initProxyServer(host: string, port: number, isConnect = false): void {
        const server = net.createServer({ allowHalfOpen: true });
        server.on('connection', (conn: net.Socket) => this.handleProxyConn(isConnect, conn));
        server.listen(port, host, () => {
            this.logger.info(`proxy server listen on tcp://${host}:${port}`);
        });
        this._proxyServers = this._proxyServers ?? [];
        this._proxyServers.push(server);
    }

    bootstrap(): void {
        // 预热：尽早建立隧道以暴露配置错误；失败也不致命，后续按需重连。
        this.getSession().catch((err) => this.logger.error(`initial tunnel setup failed: ${(err as Error).message}`));
        this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenPort);
        if (this.cliOpts.listenHttpPort) {
            this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenHttpPort, true);
        }
    }

    close(): void {
        this.session?.close();
        for (const s of this._proxyServers ?? []) {
            try {
                s.close();
            } catch (_e) {
                // ignore
            }
        }
    }
}

export default Client;
