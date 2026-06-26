const test = require('node:test');
const assert = require('node:assert');
const frameSegment = require('../../lib/protocol/segment');

test('小帧不分片', () => {
    const frame = { cid: 1, type: 1, data: Buffer.alloc(100, 0xab) };
    const parts = [];
    frameSegment(frame, (part) => parts.push(part));
    assert.strictEqual(parts.length, 1);
    assert.ok(parts[0].data.equals(frame.data));
});

test('大帧按 2KB 分片且拼接后等价', () => {
    const payload = Buffer.alloc(5000, 0xcd);
    const frame = { cid: 2, type: 1, data: payload };
    const parts = [];
    frameSegment(frame, (part) => parts.push(part));

    assert.ok(parts.length > 1);
    parts.forEach((part) => assert.ok(part.data.length <= 2048));
    const merged = Buffer.concat(parts.map((p) => p.data));
    assert.ok(merged.equals(payload));
});
