import { EventEmitter } from 'events';
import type { Duplex } from 'stream';
import { Client as yamuxClient, Server as yamuxServer, YamuxStream } from '@bbk47/yamux';
import type { YamuxSession, YamuxConfig } from '@bbk47/yamux';
import { readN } from './ioutil';

// 流级握手 / 复用参数（与 bbk-go src/tunnel 对齐）。
const MAX_ADDR_LEN = 1024; // 目标地址长度上限（socks5 地址最大约 262 字节）
const HANDSHAKE_TIMEOUT = 15 * 1000; // accept 侧读取地址头的超时
const OPEN_WAIT_TIMEOUT = 15 * 1000; // OpenStream 后等待对端就绪状态的超时
const MUX_WINDOW = 256 * 1024; // 与 bbk-go / 旧 toolbox-mux 默认窗口一致

// @bbk47/yamux 没有内置自动保活（只暴露手动 ping），这里用一个 ping 定时器复刻
// yamux 的 keepalive：周期性 ping，对端无响应即判定连接已死并关闭会话。
const KEEPALIVE_INTERVAL = 15 * 1000;
const KEEPALIVE_TIMEOUT = 10 * 1000;

export const STATUS_OK = 0x00; // 目标连接已就绪（取代旧的 EST 帧）
export const STATUS_FAIL = 0x01; // 目标连接失败

// TunnelStream 是 yamux.Stream 增补 bbk 需要的目标地址与半关闭/就绪语义后的别名。
export interface TunnelStream extends YamuxStream {
    // addr 是该流的目标地址（socks5 地址字节，或 UDP 关联哨兵），
    // 由流级握手在建立时传递，取代旧协议的 INIT 帧负载。
    addr: Buffer;
    // cid 沿用旧 stub.Stream.Cid 的语义，便于日志/调用方过渡。
    cid: number;
    // setReady 由 server 端在目标连接就绪后调用，回送 1 字节就绪状态（取代 EST 帧）。
    setReady(): void;
    // closeWrite 关闭本端写端：发送 FIN 通知对端，本端读端仍可继续读，实现半关闭。
    closeWrite(): void;
}

function yamuxConfig(): YamuxConfig {
    return {
        initialStreamWindow: MUX_WINDOW,
    };
}

// Session 封装 yamux 会话，并补上 yamux 不负责的“流级握手”
// （目标地址 + 就绪确认），取代旧的 stub.TunnelStub。
//
// 服务端会在每条流完成地址握手后 emit('stream', stream)；会话错误 emit('error')。
export class Session extends EventEmitter {
    private mux: YamuxSession;
    private isServer: boolean;
    private closed = false;
    private keepAliveTimer?: NodeJS.Timeout;

    constructor(carrier: Duplex, isServer: boolean) {
        super();
        this.isServer = isServer;

        // @bbk47/yamux 直接接管载体（事件驱动：监听 carrier 的 'data'、写回 carrier），
        // 不再使用 carrier.pipe(mux).pipe(carrier) 的管道模型。
        this.mux = isServer ? yamuxServer(carrier, yamuxConfig()) : yamuxClient(carrier, yamuxConfig());

        if (isServer) {
            this.mux.on('stream', (stream) => {
                void this.onIncoming(stream as YamuxStream);
            });
        }

        const onErr = (err: Error) => this.emit('error', err);
        carrier.on('error', onErr);
        this.mux.on('error', onErr);
        carrier.on('close', () => this.close());

        this.startKeepAlive();
    }

    // openStream 打开一条新流并完成握手：写出目标地址，等待对端回送就绪状态。
    // 返回时该流已“连接建立”，可直接开始转发（等价于旧的 INIT→EST 流程）。
    async openStream(addr: Buffer): Promise<TunnelStream> {
        const raw = this.mux.openStream();
        const stream = augment(raw, addr);
        writeAddr(stream, addr);

        let sb: Buffer;
        try {
            sb = await readN(stream, 1, OPEN_WAIT_TIMEOUT);
        } catch (err) {
            stream.destroy();
            throw err;
        }
        if (sb[0] !== STATUS_OK) {
            stream.destroy();
            throw new Error('tunnel: remote refused stream');
        }
        return stream;
    }

    // onIncoming 接受一条新流并读取其目标地址头；握手失败则丢弃该流，不影响会话。
    private async onIncoming(raw: YamuxStream): Promise<void> {
        let addr: Buffer;
        try {
            addr = await readAddr(raw, HANDSHAKE_TIMEOUT);
        } catch (_err) {
            raw.destroy();
            return;
        }
        const stream = augment(raw, addr);
        this.emit('stream', stream);
    }

    private startKeepAlive(): void {
        this.keepAliveTimer = setInterval(() => {
            if (this.closed) return;
            this.mux.ping(KEEPALIVE_TIMEOUT).catch(() => {
                // 对端无响应（或连接已死）：主动关闭会话，触发上层重连/清理。
                this.close();
            });
        }, KEEPALIVE_INTERVAL);
        // 不让保活定时器单独把进程拖住。
        this.keepAliveTimer.unref?.();
    }

    isClosed(): boolean {
        return this.closed;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = undefined;
        }
        try {
            this.mux.close();
        } catch (_e) {
            // ignore
        }
    }
}

// augment 把一条 yamux Stream 增补为 TunnelStream：附上 addr/cid 与就绪/半关闭方法。
//
// 与旧 yamux-js 不同，@bbk47/yamux 的 Stream 已实现 _final：可写侧 end() 会自动发送 FIN，
// 收到对端 FIN 会 emit 'end'，因此这里无需再手动挂 'finish' 钩子补发 FIN。
function augment(raw: YamuxStream, addr: Buffer): TunnelStream {
    const stream = raw as TunnelStream;
    stream.addr = addr;
    stream.cid = raw.streamId;

    stream.setReady = () => {
        stream.write(Buffer.from([STATUS_OK]));
    };
    stream.closeWrite = () => {
        stream.end(); // 发送 FIN，进入本端写关闭（读端仍可工作）
    };
    return stream;
}

// writeAddr 以 [2字节大端长度][addr] 写出目标地址。
function writeAddr(stream: YamuxStream, addr: Buffer): void {
    if (addr.length > MAX_ADDR_LEN) {
        throw new Error('tunnel: addr too long');
    }
    const head = Buffer.allocUnsafe(2);
    head.writeUInt16BE(addr.length, 0);
    stream.write(Buffer.concat([head, addr]));
}

// readAddr 读取以长度前缀界定的目标地址。
async function readAddr(stream: YamuxStream, timeoutMs: number): Promise<Buffer> {
    const lb = await readN(stream, 2, timeoutMs);
    const n = lb.readUInt16BE(0);
    if (n > MAX_ADDR_LEN) {
        throw new Error('tunnel: addr too long');
    }
    return readN(stream, n, timeoutMs);
}
