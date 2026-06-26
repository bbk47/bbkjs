import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import * as net from 'net';
import { socks5 } from '@bbk47/toolbox';
import StubWorker from '../../src/stub';
import { createTcpTransport } from '../../src/transport';
import Server from '../../src/Server';
import { getFreePort } from '../helpers/ports';
import { makeEncryptedSerializer, makeServerConfig, setupStubPair, TEST_PASSWORD, TEST_METHOD } from '../helpers/fixtures';
import { startEchoServer } from '../helpers/servers';

const { buildSocks5Addr } = socks5;

function closeNetServer(server: net.Server | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (!server || !server.listening) { resolve(); return; }
        server.close(() => resolve());
    });
}

test('StubWorker 经真实 TCP + 加密序列化器双向回显', async (t) => {
    const echo = await startEchoServer();
    t.after(() => echo.close());

    const brokerPort = await getFreePort();
    const serverCfg = makeServerConfig({ listenPort: brokerPort, workMode: 'tcp' });
    const broker = new Server(serverCfg as any);
    broker.bootstrap();

    const tsport = await new Promise<ReturnType<typeof createTcpTransport>>((resolve, reject) => {
        let transport: ReturnType<typeof createTcpTransport>;
        transport = createTcpTransport({ host: '127.0.0.1', port: brokerPort }, () => resolve(transport));
        (transport.conn as net.Socket).once('error', reject);
    });
    const clientStub = new StubWorker(tsport, makeEncryptedSerializer(TEST_PASSWORD, TEST_METHOD));

    const addr = buildSocks5Addr('127.0.0.1', echo.port);
    const cs = clientStub.startStream(addr);
    cs.on('error', () => {});

    await new Promise<void>((resolve, reject) => {
        clientStub.once('stream', resolve as any);
        clientStub.once('error', reject);
        setTimeout(() => reject(new Error('stream ready timeout')), 5000);
    });

    const payload = crypto.randomBytes(64 * 1024);
    const recv = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        cs.on('data', (d: Buffer) => chunks.push(d));
        cs.on('end', () => resolve(Buffer.concat(chunks)));
        cs.on('error', reject);
        cs.end(payload);
    });

    assert.ok(recv.equals(payload));
    clientStub.close();
    await closeNetServer((broker as any)._server);
});

test('加密 StubWorker loopback 多路复用两条流互不干扰', async () => {
    const { client, server } = setupStubPair({ encrypted: true });

    server.on('stream', (stream: any, addr: Buffer) => {
        server.setReady(stream);
        const port = addr.readUInt16BE(addr.length - 2);
        stream.on('data', () => stream.write(Buffer.from(`p${port}`)));
        stream.on('end', () => stream.end());
        stream.on('error', () => {});
    });

    async function openStream(port: number): Promise<string> {
        const addr = buildSocks5Addr('127.0.0.1', port);
        const cs = client.startStream(addr);
        cs.on('error', () => {});
        await new Promise<void>((resolve) => client.once('stream', resolve as any));
        return new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            cs.on('data', (d: Buffer) => chunks.push(d));
            cs.on('end', () => resolve(Buffer.concat(chunks).toString()));
            cs.on('error', reject);
            cs.end(Buffer.from('x'));
        });
    }

    const [a, b] = await Promise.all([openStream(8080), openStream(9090)]);
    assert.strictEqual(a, 'p8080');
    assert.strictEqual(b, 'p9090');
    client.close();
    server.close();
});
