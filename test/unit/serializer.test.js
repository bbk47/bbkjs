const test = require('node:test');
const assert = require('node:assert');
const protocol = require('../../lib/protocol');
const { makeEncryptedSerializer } = require('../helpers/fixtures');

test('加密序列化器 encrypt/decrypt 往返', () => {
    const ser = makeEncryptedSerializer();
    const frame = { cid: 99, type: protocol.INIT_FRAME, data: Buffer.from([0x01, 127, 0, 0, 1, 0, 0x50]) };
    const wire = ser.serialize(frame);
    const decoded = ser.derialize(wire);

    assert.strictEqual(decoded.type, frame.type);
    assert.strictEqual(decoded.cid, frame.cid);
    assert.ok(decoded.data.equals(frame.data));
});

test('错误密码解密结果与原文不一致', () => {
    const serA = makeEncryptedSerializer('pass-a');
    const serB = makeEncryptedSerializer('pass-b');
    const frame = { cid: 1, type: protocol.PING_FRAME, data: Buffer.from('1234567890123') };
    const wire = serA.serialize(frame);
    const decoded = serB.derialize(wire);
    assert.notStrictEqual(decoded.cid, frame.cid);
});
