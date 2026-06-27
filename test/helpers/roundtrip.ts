import * as net from 'net';
import * as dgram from 'dgram';
import { socks5 } from '@bbk47/toolbox';
import { socks5Connect } from './socks5Client';

const { buildSocks5Addr } = socks5;

// tcpRoundtrip 经 socks5 代理建立一条 CONNECT 流，写入 payload 并读回等长回显后校验一致。
// 返回前会关闭连接，便于压测做"开/关流"churn。
export async function tcpRoundtrip(
    proxyHost: string,
    proxyPort: number,
    targetHost: string,
    targetPort: number,
    payload: Buffer,
    timeoutMs: number
): Promise<void> {
    const socket = await socks5Connect({ proxyHost, proxyPort, targetHost, targetPort });
    try {
        const recv = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let got = 0;
            const timer = setTimeout(() => reject(new Error('tcp roundtrip timeout')), timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                socket.removeListener('data', onData);
                socket.removeListener('error', onErr);
                socket.removeListener('end', onEnd);
            };
            const onData = (d: Buffer) => {
                chunks.push(d);
                got += d.length;
                if (got >= payload.length) {
                    cleanup();
                    resolve(Buffer.concat(chunks).subarray(0, payload.length));
                }
            };
            const onErr = (err: Error) => {
                cleanup();
                reject(err);
            };
            const onEnd = () => {
                cleanup();
                reject(new Error('tcp roundtrip ended early'));
            };
            socket.on('data', onData);
            socket.once('error', onErr);
            socket.once('end', onEnd);
            socket.write(payload);
        });
        if (!recv.equals(payload)) {
            throw new Error('tcp payload mismatch');
        }
    } finally {
        socket.destroy();
    }
}

// 解析 socks5 地址(ATYP+ADDR+PORT)所占字节数，仅覆盖 IPv4/domain/IPv6。
function socks5AddrLen(b: Buffer, off: number): number {
    switch (b[off]) {
        case 0x01:
            return 7;
        case 0x03:
            return 1 + 1 + b[off + 1] + 2;
        case 0x04:
            return 19;
        default:
            throw new Error('bad socks5 atyp:' + b[off]);
    }
}

// udpRoundtrip 完整跑一次 socks5 UDP ASSOCIATE：建控制连接 -> 取中继地址 ->
// 发一条 UDP 数据报 -> 收回显 -> 关闭。校验回显 payload 与发送一致。
// UDP_RETRANSMIT_MS：重发间隔。SOCKS5 代理在隧道流就绪前就回送了 ASSOCIATE 应答，
// 首个数据报可能在中继侧监听器挂上前到达而被丢弃；加之 UDP 本就不可靠，
// 真实客户端必须重传。这里在超时窗口内周期重发，直到收到回显。
const UDP_RETRANSMIT_MS = 150;

export function udpRoundtrip(
    proxyHost: string,
    proxyPort: number,
    targetHost: string,
    targetPort: number,
    payload: Buffer,
    timeoutMs: number
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const ctrl = net.connect(proxyPort, proxyHost);
        const udp = dgram.createSocket('udp4');
        let stage: 'greet' | 'assoc' | 'relay' = 'greet';
        let done = false;
        let retransmit: NodeJS.Timeout | undefined;

        const timer = setTimeout(() => fail(new Error('udp roundtrip timeout')), timeoutMs);

        function finish(err?: Error): void {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (retransmit) clearInterval(retransmit);
            ctrl.removeAllListeners();
            ctrl.destroy();
            try {
                udp.close();
            } catch (_e) {
                // ignore
            }
            err ? reject(err) : resolve();
        }
        const fail = (e: Error) => finish(e);

        ctrl.on('error', fail);
        udp.on('error', fail);
        ctrl.on('connect', () => ctrl.write(Buffer.from([0x05, 0x01, 0x00])));

        ctrl.on('data', (data: Buffer) => {
            if (stage === 'greet') {
                if (data[0] !== 0x05 || data[1] !== 0x00) return fail(new Error('udp greet failed'));
                stage = 'assoc';
                ctrl.write(Buffer.concat([Buffer.from([0x05, 0x03, 0x00]), buildSocks5Addr('0.0.0.0', 0)]));
                return;
            }
            if (stage === 'assoc') {
                if (data[0] !== 0x05 || data[1] !== 0x00) return fail(new Error('udp associate failed'));
                let relayHost: string;
                let relayPort: number;
                try {
                    const atyp = data[3];
                    if (atyp === 0x01) {
                        relayHost = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
                        relayPort = data.readUInt16BE(8);
                    } else {
                        return fail(new Error('unsupported relay atyp:' + atyp));
                    }
                } catch (e) {
                    return fail(e as Error);
                }
                stage = 'relay';
                // SOCKS5 UDP 请求头：RSV(2)=0 FRAG(1)=0 + socks5(target) + payload
                const dgramBuf = Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), buildSocks5Addr(targetHost, targetPort), payload]);
                const sendOnce = () => {
                    if (done) return;
                    udp.send(dgramBuf, relayPort, relayHost, (err) => {
                        if (err) fail(err);
                    });
                };
                sendOnce();
                retransmit = setInterval(sendOnce, UDP_RETRANSMIT_MS);
                return;
            }
        });

        udp.on('message', (msg: Buffer) => {
            if (stage !== 'relay') return;
            try {
                // 回包：RSV(2)+FRAG(1)+socks5addr+payload
                const alen = socks5AddrLen(msg, 3);
                const echoed = msg.subarray(3 + alen);
                if (!echoed.equals(payload)) return fail(new Error('udp payload mismatch'));
                finish();
            } catch (e) {
                fail(e as Error);
            }
        });
    });
}
