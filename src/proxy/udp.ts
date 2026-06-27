import * as dgram from 'dgram';
import type { Duplex } from 'stream';
import type { Logger } from '@bbk47/toolbox';

// UDP 代理整体设计（shadowsocks 风格：不支持分片），与 bbk-go src/proxy/udprelay.go 对齐：
//
//   app(UDP) --SOCKS5 UDP datagram--> Client relay socket
//      --(length-prefixed: socks5addr+payload over a mux stream)--> Server
//      Server 按 socks5addr 维护到各目标的 UDP socket(NAT 会话表)并收发
//
// 关键约束：
//   - 不支持分片：SOCKS5 UDP 头里的 FRAG 字段必须为 0，否则丢弃该数据报。
//   - 复用现有 mux stream（字节流），因此每个 UDP 数据报用 2 字节大端长度前缀
//     界定边界：[len(2)][ socks5addr + payload ]。

const MAX_UDP_DATAGRAM = 64 * 1024; // 受 2 字节长度前缀限制
const UDP_IDLE_TIMEOUT = 60 * 1000; // server 侧到目标的 UDP 会话空闲回收

// udpMarker 是 UDP ASSOCIATE 关联流的哨兵目标地址。
// 普通 TCP 流的 socks5 地址首字节恒为 0x01/0x03/0x04，0xFD 不会与之冲突。
const UDP_MARKER = Buffer.from([0xfd, 0x55, 0x44, 0x50]); // 0xFD 'U' 'D' 'P'

export function udpMarkerAddr(): Buffer {
    return Buffer.from(UDP_MARKER);
}

export function isUDPMarker(addr: Buffer): boolean {
    return addr.equals(UDP_MARKER);
}

// socks5AddrLen 返回一段 buffer 开头的 socks5 地址(ATYP+ADDR+PORT)所占字节数。
function socks5AddrLen(b: Buffer): number {
    if (b.length < 1) throw new Error('socks5 addr empty');
    switch (b[0]) {
        case 0x01: // IPv4
            if (b.length < 7) throw new Error('socks5 addr ipv4 too short');
            return 7;
        case 0x03: {
            // domain
            if (b.length < 2) throw new Error('socks5 addr domain too short');
            const n = 1 + 1 + b[1] + 2;
            if (b.length < n) throw new Error('socks5 addr domain truncated');
            return n;
        }
        case 0x04: // IPv6
            if (b.length < 19) throw new Error('socks5 addr ipv6 too short');
            return 19;
        default:
            throw new Error('socks5 addr invalid atyp:' + b[0]);
    }
}

// pumpDatagrams 从字节流上按 [2字节大端长度][数据] 解析记录边界，逐条回调。
function pumpDatagrams(stream: Duplex, onRecord: (rec: Buffer) => void): void {
    let buf = Buffer.alloc(0);
    stream.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
            const n = buf.readUInt16BE(0);
            if (buf.length < 2 + n) break;
            onRecord(Buffer.from(buf.subarray(2, 2 + n)));
            buf = buf.subarray(2 + n);
        }
    });
}

// writeDatagram 把一条 UDP 记录以 [2字节大端长度][数据] 写入字节流。
function writeDatagram(stream: Duplex, data: Buffer): boolean {
    if (data.length > MAX_UDP_DATAGRAM) return false;
    const head = Buffer.allocUnsafe(2);
    head.writeUInt16BE(data.length, 0);
    return stream.write(Buffer.concat([head, data]));
}

function parseTarget(addrBytes: Buffer): { host: string; port: number } {
    const atyp = addrBytes[0];
    if (atyp === 0x01) {
        const host = `${addrBytes[1]}.${addrBytes[2]}.${addrBytes[3]}.${addrBytes[4]}`;
        const port = addrBytes.readUInt16BE(5);
        return { host, port };
    } else if (atyp === 0x03) {
        const len = addrBytes[1];
        const host = addrBytes.subarray(2, 2 + len).toString();
        const port = addrBytes.readUInt16BE(2 + len);
        return { host, port };
    }
    throw new Error('unsupported socks5 atyp for udp:' + atyp);
}

// serveUDP 运行 server 侧的 UDP 中继：从 stream 读取 "socks5addr+payload" 记录，
// 按目标维护 UDP socket 会话表并转发；目标回包再写回 stream。
// stream 关闭即结束并回收所有目标连接。对应 bbk-go ServeUDP。
export function serveUDP(stream: Duplex, logger?: Logger): void {
    const conns = new Map<string, { socket: dgram.Socket; timer: NodeJS.Timeout }>();

    const cleanup = () => {
        for (const { socket, timer } of conns.values()) {
            clearTimeout(timer);
            try {
                socket.close();
            } catch (_e) {
                // ignore
            }
        }
        conns.clear();
    };
    stream.on('close', cleanup);
    stream.on('end', () => stream.destroy());

    pumpDatagrams(stream, (rec) => {
        let alen: number;
        try {
            alen = socks5AddrLen(rec);
        } catch (_e) {
            return; // 地址非法，丢弃
        }
        const addrBytes = rec.subarray(0, alen);
        const payload = rec.subarray(alen);
        let target: { host: string; port: number };
        try {
            target = parseTarget(addrBytes);
        } catch (_e) {
            return;
        }
        const key = `${target.host}:${target.port}`;

        let entry = conns.get(key);
        if (!entry) {
            const socket = dgram.createSocket('udp4');
            const refresh = () => {
                const old = conns.get(key);
                if (old) clearTimeout(old.timer);
                const timer = setTimeout(() => {
                    conns.delete(key);
                    try {
                        socket.close();
                    } catch (_e) {
                        // ignore
                    }
                }, UDP_IDLE_TIMEOUT);
                conns.set(key, { socket, timer });
            };
            const ab = Buffer.from(addrBytes);
            socket.on('message', (msg: Buffer) => {
                refresh();
                writeDatagram(stream, Buffer.concat([ab, msg]));
            });
            socket.on('error', (err) => {
                logger?.debug(`udp target ${key} err:${err.message}`);
                const e = conns.get(key);
                if (e) clearTimeout(e.timer);
                conns.delete(key);
                try {
                    socket.close();
                } catch (_e) {
                    // ignore
                }
            });
            entry = { socket, timer: setTimeout(() => {}, 0) };
            conns.set(key, entry);
            refresh();
        } else {
            const e = conns.get(key)!;
            clearTimeout(e.timer);
            e.timer = setTimeout(() => {
                conns.delete(key);
                try {
                    e.socket.close();
                } catch (_err) {
                    // ignore
                }
            }, UDP_IDLE_TIMEOUT);
        }

        entry.socket.send(payload, target.port, target.host, (err) => {
            if (err) logger?.debug(`udp write ${key} err:${err.message}`);
        });
    });
}

// clientUDP 运行 client 侧的 UDP 中继：把 app 经 relay socket 发来的 SOCKS5 UDP
// 数据报(剥掉 RSV+FRAG，校验不分片)按长度前缀写入 stream；stream 回来的记录再
// 补上 RSV+FRAG 头回送给 app。relay socket 或 stream 任一关闭即结束。
// 对应 bbk-go ClientUDP。
export function clientUDP(udpSocket: dgram.Socket, stream: Duplex, logger?: Logger): void {
    let clientAddr: { address: string; port: number } | null = null;

    const close = () => {
        try {
            udpSocket.close();
        } catch (_e) {
            // ignore
        }
        try {
            stream.destroy();
        } catch (_e) {
            // ignore
        }
    };

    udpSocket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (msg.length < 4) return; // 至少 RSV(2)+FRAG(1)+ATYP(1)
        if (msg[2] !== 0x00) {
            logger?.debug(`udp drop fragmented datagram frag=${msg[2]}`);
            return;
        }
        clientAddr = { address: rinfo.address, port: rinfo.port };
        const rec = msg.subarray(3); // ATYP+ADDR+PORT+DATA
        writeDatagram(stream, Buffer.from(rec));
    });
    udpSocket.on('error', close);
    udpSocket.on('close', () => {
        try {
            stream.destroy();
        } catch (_e) {
            // ignore
        }
    });

    pumpDatagrams(stream, (rec) => {
        if (!clientAddr) return;
        const out = Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), rec]); // RSV(2)=0, FRAG=0
        udpSocket.send(out, clientAddr.port, clientAddr.address, (err) => {
            if (err) logger?.debug(`udp send to app err:${err.message}`);
        });
    });
    stream.on('close', close);
    stream.on('end', () => stream.destroy());
}
