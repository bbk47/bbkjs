const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const EventEmitter = require('events');

const protocol = require('../../src/protocol');
const { ADDR, setupStubPair, makePlainSerializer } = require('../helpers/fixtures');

test('握手：startStream -> 服务端收到 stream(addr)，setReady -> 客户端收到 stream', async () => {
    const { client, server } = setupStubPair();
    const got = await new Promise((resolve) => {
        server.on('stream', (stream, addr) => {
            server.setReady(stream);
            resolve({ addr });
        });
        client.startStream(ADDR);
    });
    assert.deepStrictEqual(got.addr, ADDR);

    await new Promise((resolve) => client.on('stream', () => resolve()));
    client.close();
    server.close();
});

test('双向回显 + 流控 + 分片：1MB 数据完整往返', async () => {
    const { client, server } = setupStubPair();
    server.on('stream', (stream) => {
        server.setReady(stream);
        stream.on('data', (d) => stream.write(d));
        stream.on('end', () => stream.end());
        stream.on('error', () => {});
    });

    const payload = crypto.randomBytes(1024 * 1024);
    const cs = client.startStream(ADDR);
    cs.on('error', () => {});

    const recv = await new Promise((resolve, reject) => {
        const chunks = [];
        cs.on('data', (d) => chunks.push(d));
        cs.on('end', () => resolve(Buffer.concat(chunks)));
        cs.on('error', reject);
        cs.end(payload);
    });

    assert.strictEqual(recv.length, payload.length);
    assert.ok(recv.equals(payload));
    client.close();
    server.close();
});

test('半关闭：客户端 end 后服务端仍可回发数据', async () => {
    const { client, server } = setupStubPair();
    const events = [];
    server.on('stream', (stream) => {
        server.setReady(stream);
        stream.on('data', (d) => events.push('recv:' + d.toString()));
        stream.on('end', () => {
            events.push('server-end');
            stream.write(Buffer.from('reply-after-fin'));
            stream.end();
        });
        stream.on('error', () => {});
    });

    const cs = client.startStream(ADDR);
    cs.on('error', () => {});
    const reply = await new Promise((resolve) => {
        const chunks = [];
        cs.on('data', (d) => chunks.push(d));
        cs.on('end', () => resolve(Buffer.concat(chunks).toString()));
        cs.end(Buffer.from('hello'));
    });

    assert.strictEqual(reply, 'reply-after-fin');
    assert.ok(events.includes('recv:hello'));
    assert.ok(events.includes('server-end'));
    client.close();
    server.close();
});

test('RST：客户端 destroy 流 -> 服务端对应流被复位关闭', async () => {
    const { client, server } = setupStubPair();
    const serverStreamP = new Promise((resolve) => {
        server.on('stream', (stream) => {
            server.setReady(stream);
            stream.on('error', () => {});
            resolve(stream);
        });
    });

    const cs = client.startStream(ADDR);
    cs.on('error', () => {});
    const serverStream = await serverStreamP;

    const closed = new Promise((resolve) => serverStream.on('close', resolve));
    cs.destroy();
    await closed;
    assert.strictEqual(serverStream.destroyed, true);
    client.close();
    server.close();
});

test('未知流的数据帧触发对端 RST', async () => {
    const { client, server, ta } = setupStubPair();
    const cid = 123456;
    const ser = makePlainSerializer();
    const pkt = ser.serialize({ cid, type: protocol.STREAM_FRAME, data: Buffer.from([1, 2, 3]) });

    const rstSeen = new Promise((resolve) => {
        const origOnData = ta.onData;
        ta.onData = (packet) => {
            try {
                const f = makePlainSerializer().derialize(packet);
                if (f.type === protocol.RST_FRAME && f.cid === cid) resolve(true);
            } catch (e) {}
            origOnData(packet);
        };
    });

    server.dataListener(pkt);
    assert.strictEqual(await rstSeen, true);
    client.close();
    server.close();
});

test('ping/pong 健康检查', async () => {
    const { client, server } = setupStubPair();
    const pong = new Promise((resolve) => client.on('pong', resolve));
    client.ping();
    const pe = await pong;
    assert.strictEqual(typeof pe.up, 'number');
    assert.strictEqual(typeof pe.down, 'number');
    client.close();
    server.close();
});

test('调度器：底层连接背压时暂停发送，drain 后恢复', async () => {
    const sent = [];
    const fakeSocket = new EventEmitter();
    fakeSocket.write = () => true;
    fakeSocket.writableLength = 2 * 1024 * 1024;

    const tsport = {
        conn: fakeSocket,
        sendPacket: (buf) => sent.push(buf),
        bindEvents: () => {},
        close: () => {},
    };
    const StubWorker = require('../../src/stub').default;
    const sw = new StubWorker(tsport, makePlainSerializer());

    sw._sendFrame({ cid: 7, type: protocol.STREAM_FRAME, data: Buffer.from('abc') });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(sent.length, 0, '背压期间不发送');

    fakeSocket.writableLength = 0;
    fakeSocket.emit('drain');
    await new Promise((r) => setImmediate(r));
    assert.ok(sent.length > 0, 'drain 后恢复发送');
});
