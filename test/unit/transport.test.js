const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const transport = require('../../lib/transport');

test('tcpsocketSend + bindStreamSocket 按 2 字节长度前缀分帧', () => {
    const received = [];
    const stream = new PassThrough();
    transport.wrapSocket('tcp', stream).bindEvents(
        (buf) => received.push(Buffer.from(buf)),
        () => {},
        () => {}
    );

    const payload = Buffer.from('hello-bbk');
    const ts = transport.wrapSocket('tcp', stream);
    ts.sendPacket(payload);
    ts.sendPacket(Buffer.from([0x01, 0x02]));

    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].toString(), 'hello-bbk');
    assert.deepStrictEqual([...received[1]], [1, 2]);
});

test('半包缓存：分两次 write 仍能拼出完整 packet', () => {
    const received = [];
    const stream = new PassThrough();
    transport.wrapSocket('tcp', stream).bindEvents(
        (buf) => received.push(Buffer.from(buf)),
        () => {},
        () => {}
    );

    const payload = Buffer.from('partial-frame');
    const framed = Buffer.concat([Buffer.from([0x00, payload.length]), payload]);
    stream.write(framed.slice(0, 3));
    stream.write(framed.slice(3));

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].toString(), 'partial-frame');
});
