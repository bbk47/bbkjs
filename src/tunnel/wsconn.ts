import { Duplex } from 'stream';
import type WebSocket from 'ws';

// WsConn 把 ws 的"消息流" WebSocket 适配成 yamux/SecureConn 需要的"字节流" Duplex。
// WebSocket 以离散二进制消息为单位，这里在读侧把多条消息拼接成连续字节，
// 在写侧把每次 _write 作为一条二进制消息发出。
export class WsConn extends Duplex {
    private ws: WebSocket;

    constructor(ws: WebSocket) {
        super();
        this.ws = ws;

        this.ws.on('message', (data: WebSocket.RawData, isBinary?: boolean) => {
            void isBinary;
            const buf = toBuffer(data);
            if (buf.length > 0) this.push(buf);
        });
        this.ws.on('close', () => this.push(null));
        this.ws.on('error', (err: Error) => this.destroy(err));
    }

    _read(): void {
        // ws 自身按消息推送，这里无需主动拉取。
    }

    _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
        this.ws.send(chunk, { binary: true }, (err) => cb(err ?? null));
    }

    _final(cb: (err?: Error | null) => void): void {
        try {
            this.ws.close();
        } catch (_e) {
            // ignore
        }
        cb();
    }

    _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
        try {
            this.ws.close();
        } catch (_e) {
            // ignore
        }
        cb(err);
    }
}

function toBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
}
