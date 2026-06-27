import * as crypto from 'crypto';
import { Duplex } from 'stream';
import type { Cipheriv, Decipheriv } from 'crypto';
import { encrypt } from '@bbk47/toolbox';
import { readN } from './ioutil';

// secure 握手读超时：防止对端打开载体却不发 IV 而无限阻塞。
const SECURE_HANDSHAKE_TIMEOUT = 15 * 1000;

// SecureConn 在一条裸字节流(raw Duplex)之上做整条连接的流式加密。
//
// 与旧的"逐帧、固定 IV"CFB 不同：每条连接握手时双方各自生成一个随机 IV 明文发出，
// 各自用"自己的 IV"初始化出站加密流、用"对端的 IV"初始化入站解密流，
// 两个方向各自一条连续 keystream，既消除了固定 IV 的 keystream 复用隐患，
// 也给 yamux 提供了它要求的"干净有序字节流"。
//
// 对外暴露为明文 Duplex：写入的明文会被加密后送往 raw，raw 收到的密文会被解密后
// 从可读侧吐出，从而可以直接 `secure.pipe(yamux).pipe(secure)`。
export class SecureConn extends Duplex {
    private raw: Duplex;
    private enc: Cipheriv;
    private dec: Decipheriv;

    private constructor(raw: Duplex, enc: Cipheriv, dec: Decipheriv) {
        super();
        this.raw = raw;
        this.enc = enc;
        this.dec = dec;

        this.raw.on('data', (chunk: Buffer) => {
            // 仅对真实读到的字节解密，保持 keystream 与有序字节流同步推进。
            const plain = this.dec.update(chunk);
            if (plain.length > 0 && !this.push(plain)) {
                this.raw.pause();
            }
        });
        this.raw.on('end', () => this.push(null));
        this.raw.on('close', () => {
            this.destroy();
        });
        this.raw.on('error', (err: Error) => this.destroy(err));
    }

    _read(): void {
        this.raw.resume();
    }

    _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
        if (chunk.length === 0) {
            cb();
            return;
        }
        const out = this.enc.update(chunk);
        if (out.length === 0) {
            cb();
            return;
        }
        this.raw.write(out, cb);
    }

    _final(cb: (err?: Error | null) => void): void {
        try {
            this.raw.end();
        } catch (_e) {
            // ignore
        }
        cb();
    }

    _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
        try {
            this.raw.destroy();
        } catch (_e) {
            // ignore
        }
        cb(err);
    }

    // secure 是 client/server 对称的握手：双方各自生成随机 IV 明文交换，
    // 然后用本端 IV 建加密流、对端 IV 建解密流。
    private static async secure(raw: Duplex, method: string, password: string): Promise<SecureConn> {
        const worker = new encrypt.Encryptor(password, method as encrypt.CipherMethod);
        const key = (worker as unknown as { _EVP_KEY: Buffer })._EVP_KEY;
        const ivLen = (worker as unknown as { _IV: Buffer })._IV.length;

        const localIV = ivLen > 0 ? crypto.randomBytes(ivLen) : Buffer.alloc(0);
        if (localIV.length > 0) {
            raw.write(localIV);
        }

        const peerIV = await readN(raw, ivLen, SECURE_HANDSHAKE_TIMEOUT);

        const enc = crypto.createCipheriv(method, key, localIV.length > 0 ? localIV : null);
        const dec = crypto.createDecipheriv(method, key, peerIV.length > 0 ? peerIV : null);
        return new SecureConn(raw, enc, dec);
    }

    // clientSecure 在客户端侧用给定方法/口令包裹一条裸连接。
    static clientSecure(raw: Duplex, method: string, password: string): Promise<SecureConn> {
        return SecureConn.secure(raw, method, password);
    }

    // serverSecure 在服务端侧用给定方法/口令包裹一条裸连接。
    static serverSecure(raw: Duplex, method: string, password: string): Promise<SecureConn> {
        return SecureConn.secure(raw, method, password);
    }
}
