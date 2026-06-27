import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import * as net from 'net';
import { socks5 } from '@bbk47/toolbox';
import { SecureConn, Session } from '../../src/tunnel';
import type { TunnelStream } from '../../src/tunnel';
import { getFreePort } from '../helpers/ports';
import { TEST_PASSWORD, TEST_METHOD } from '../helpers/fixtures';

const { buildSocks5Addr } = socks5;

// startTunnelServer 起一个最小的 yamux 隧道服务端：每条流握手后回显其写入数据。
async function startTunnelServer() {
    const port = await getFreePort();
    const sessions: Session[] = [];
    const server = net.createServer(async (socket) => {
        try {
            const secure = await SecureConn.serverSecure(socket, TEST_METHOD, TEST_PASSWORD);
            const sess = new Session(secure, true);
            sessions.push(sess);
            sess.on('error', () => {});
            sess.on('stream', (stream: TunnelStream) => {
                stream.setReady();
                stream.on('error', () => {});
                stream.pipe(stream); // echo
            });
        } catch (_e) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return {
        port,
        close: () =>
            new Promise<void>((resolve) => {
                sessions.forEach((s) => s.close());
                server.close(() => resolve());
            }),
    };
}

async function connectClientSession(port: number): Promise<Session> {
    const socket: net.Socket = await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
    });
    const secure = await SecureConn.clientSecure(socket, TEST_METHOD, TEST_PASSWORD);
    return new Session(secure, false);
}

test('SecureConn + yamux Session 经真实 TCP 双向回显', async (t) => {
    const srv = await startTunnelServer();
    t.after(() => srv.close());

    const sess = await connectClientSession(srv.port);
    const stream = await sess.openStream(buildSocks5Addr('127.0.0.1', 8080));

    const payload = crypto.randomBytes(64 * 1024);
    const recv = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (d: Buffer) => chunks.push(d));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
        stream.end(payload);
    });

    assert.ok(recv.equals(payload));
    sess.close();
});

test('yamux Session 多路复用两条流互不干扰', async (t) => {
    const srv = await startTunnelServer();
    t.after(() => srv.close());

    const sess = await connectClientSession(srv.port);

    async function roundtrip(port: number, msg: string): Promise<string> {
        const stream = await sess.openStream(buildSocks5Addr('127.0.0.1', port));
        return new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on('data', (d: Buffer) => chunks.push(d));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
            stream.on('error', reject);
            stream.end(Buffer.from(msg));
        });
    }

    const [a, b] = await Promise.all([roundtrip(8080, 'hello-8080'), roundtrip(9090, 'hello-9090')]);
    assert.strictEqual(a, 'hello-8080');
    assert.strictEqual(b, 'hello-9090');
    sess.close();
});
