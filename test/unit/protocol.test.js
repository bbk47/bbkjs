const test = require('node:test');
const assert = require('node:assert');
const protocol = require('../../src/protocol');

test('encode/decode 往返保留 version/type/cid/data', () => {
    const frame = { cid: 21382813, type: protocol.STREAM_FRAME, data: Buffer.from([1, 2, 3, 4]) };
    const encoded = protocol.encode(frame);
    const decoded = protocol.decode(encoded);

    assert.strictEqual(decoded.version, 1);
    assert.strictEqual(decoded.type, frame.type);
    assert.strictEqual(decoded.cid, frame.cid);
    assert.ok(decoded.data.equals(frame.data));
});

test('PING 帧解析 stime', () => {
    const ts = Date.now().toString();
    const frame = { cid: 0, type: protocol.PING_FRAME, data: Buffer.from(ts) };
    const decoded = protocol.decode(protocol.encode(frame));
    assert.strictEqual(decoded.stime, parseInt(ts, 10));
});

test('PONG 帧解析 stime/atime', () => {
    const stime = Date.now().toString();
    const atime = (Date.now() + 5).toString();
    const frame = { cid: 0, type: protocol.PONG_FRAME, data: Buffer.concat([Buffer.from(stime), Buffer.from(atime)]) };
    const decoded = protocol.decode(protocol.encode(frame));
    assert.strictEqual(decoded.stime, parseInt(stime, 10));
    assert.strictEqual(decoded.atime, parseInt(atime, 10));
});

test('过短数据 decode 返回无效帧字段', () => {
    const decoded = protocol.decode(Buffer.from([0x00, 0x01]));
    assert.ok(Number.isNaN(decoded.cid));
});
