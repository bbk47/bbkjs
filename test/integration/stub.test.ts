import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import * as protocol from '../../src/protocol';
import StubWorker from '../../src/stub';
import { ADDR, setupStubPair, makePlainSerializer } from '../helpers/fixtures';

test('握手：startStream -> 服务端收到 stream(addr)，setReady -> 客户端收到 stream', async () => {
    const { client, server } = setupStubPair();
    const got = await new Promise<{ addr: Buffer }>((resolve) => {
        server.on('stream', (stream: any, addr: Buffer) => {
            server.setReady(stream);
            resolve({ addr });
        });
        client.startStream(ADDR);
    });
    assert.deepStrictEqual(got.addr, ADDR);

    await new Promise<void>((resolve) => client.on('stream', () => resolve()));
    client.close();
    server.close();
});

test('双向回显 + 流控 + 分片：1MB 数据完整往返', async () => {
    const { client, server } = setupStubPair();
    server.on('stream', (stream: any) => {
        server.setReady(stream);
        stream.on('data', (d: Buffer) => stream.write(d));
        stream.on('end', () => stream.end());
        stream.on('error', () => {});
    });

    const payload = crypto.randomBytes(1024 * 1024);
    const cs = client.startStream(ADDR);
    cs.on('error', () => {});

    const recv = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        cs.on('data', (d: Buffer) => chunks.push(d));
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
    const events: string[] = [];
    server.on('stream', (stream: any) => {
        server.setReady(stream);
        stream.on('data', (d: Buffer) => events.push('recv:' + d.toString()));
        stream.on('end', () => {
            events.push('server-end');
            stream.write(Buffer.from('reply-after-fin'));
            stream.end();
        });
        stream.on('error', () => {});
    });

    const cs = client.startStream(ADDR);
    cs.on('error', () => {});
    const reply = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        cs.on('data', (d: Buffer) => chunks.push(d));
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
    const serverStreamP = new Promise<any>((resolve) => {
        server.on('stream', (stream: any) => {
            server.setReady(stream);
            stream.on('error', () => {});
            resolve(stream);
        });
    });

    const cs = client.startStream(ADDR);
    cs.on('error', () => {});
    const serverStream = await serverStreamP;

    const closed = new Promise<void>((resolve) => serverStream.on('close', resolve));
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

    const rstSeen = new Promise<boolean>((resolve) => {
        const origOnData = ta.onData!;
        ta.onData = (packet: Buffer) => {
            try {
                const f = makePlainSerializer().derialize(packet);
                if (f.type === protocol.RST_FRAME && f.cid === cid) resolve(true);
            } catch (_e) {}
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
    const pong = new Promise<{ up: number; down: number }>((resolve) => client.on('pong', resolve));
    client.ping();
    const pe = await pong;
    assert.strictEqual(typeof pe.up, 'number');
    assert.strictEqual(typeof pe.down, 'number');
    client.close();
    server.close();
});

test('调度器：底层连接背压时暂停发送，drain 后恢复', async () => {
    const sent: Buffer[] = [];
    const fakeSocket = new EventEmitter() as any;
    fakeSocket.write = () => true;
    fakeSocket.writableLength = 2 * 1024 * 1024;

    const tsport = {
        conn: fakeSocket,
        sendPacket: (buf: Buffer) => sent.push(buf),
        bindEvents: () => {},
        close: () => {},
    };
    const sw = new StubWorker(tsport as any, makePlainSerializer());

    (sw as any)._sendFrame({ cid: 7, type: protocol.STREAM_FRAME, data: Buffer.from('abc') });
    await new Promise<void>((r) => setImmediate(r));
    assert.strictEqual(sent.length, 0, '背压期间不发送');

    fakeSocket.writableLength = 0;
    fakeSocket.emit('drain');
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(sent.length > 0, 'drain 后恢复发送');
});
