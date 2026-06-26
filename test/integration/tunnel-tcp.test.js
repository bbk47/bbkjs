const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { buildSocks5Addr } = require('@bbk47/toolbox').socks5;

const StubWorker = require('../../src/stub').default;
const { createTcpTransport } = require('../../src/transport');
const Server = require('../../src/Server').default;
const { getFreePort } = require('../helpers/ports');
const { makeEncryptedSerializer, makeServerConfig, TEST_PASSWORD, TEST_METHOD } = require('../helpers/fixtures');
const { startEchoServer } = require('../helpers/servers');

function closeNetServer(server) {
    return new Promise((resolve) => {
        if (!server || !server.listening) {
            resolve();
            return;
        }
        server.close(() => resolve());
    });
}

test('StubWorker 经真实 TCP + 加密序列化器双向回显', async (t) => {
    const echo = await startEchoServer();
    t.after(() => echo.close());

    const brokerPort = await getFreePort();
    const serverCfg = makeServerConfig({ listenPort: brokerPort, workMode: 'tcp' });
    const broker = new Server(serverCfg);
    broker.bootstrap();

    const tsport = await new Promise((resolve, reject) => {
        let transport;
        transport = createTcpTransport({ host: '127.0.0.1', port: brokerPort }, () => resolve(transport));
        transport.conn.once('error', reject);
    });
    const clientStub = new StubWorker(tsport, makeEncryptedSerializer(TEST_PASSWORD, TEST_METHOD));

    const addr = buildSocks5Addr('127.0.0.1', echo.port);
    const cs = clientStub.startStream(addr);
    cs.on('error', () => {});

    await new Promise((resolve, reject) => {
        clientStub.once('stream', resolve);
        clientStub.once('error', reject);
        setTimeout(() => reject(new Error('stream ready timeout')), 5000);
    });

    const payload = crypto.randomBytes(64 * 1024);
    const recv = await new Promise((resolve, reject) => {
        const chunks = [];
        cs.on('data', (d) => chunks.push(d));
        cs.on('end', () => resolve(Buffer.concat(chunks)));
        cs.on('error', reject);
        cs.end(payload);
    });

    assert.ok(recv.equals(payload));
    clientStub.close();
    await closeNetServer(broker._server);
});

test('加密 StubWorker loopback 多路复用两条流互不干扰', async () => {
    const { client, server } = require('../helpers/fixtures').setupStubPair({ encrypted: true });

    const results = {};
    server.on('stream', (stream, addr) => {
        server.setReady(stream);
        const port = addr.readUInt16BE(addr.length - 2);
        stream.on('data', () => stream.write(Buffer.from(`p${port}`)));
        stream.on('end', () => stream.end());
        stream.on('error', () => {});
    });

    async function openStream(port) {
        const addr = buildSocks5Addr('127.0.0.1', port);
        const cs = client.startStream(addr);
        cs.on('error', () => {});
        await new Promise((resolve) => client.once('stream', resolve));
        return new Promise((resolve, reject) => {
            const chunks = [];
            cs.on('data', (d) => chunks.push(d));
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
