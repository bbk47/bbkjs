const Encryptor = require('./utils/encrypt').Encryptor;
const config = require('./option');
const crypto = require('crypto');

const fillLen = config.fillByte || 0;

const encryptWorker = new Encryptor(config.password, config.method);

/**
 *
 * @param {*} frame
 * |<------32(cid)------->|<--6(timestramp)-->|<--1(type)-->|<------------data------------->|
 *
 * @returns
 */
function serialize(frame) {
    frame.cid = frame.cid || '00000000000000000000000000000000';
    let cidBuf = Buffer.from(frame.cid);
    let typeBuf = Buffer.from([frame.type]);
    let timeBuf = Buffer.alloc(6);
    let now = Date.now();
    timeBuf.writeUIntBE(now, 0, 6);
    let fillBytes = crypto.randomBytes(fillLen);
    const result = Buffer.concat([fillBytes, cidBuf, timeBuf, typeBuf, frame.data]);
    return encryptWorker.encrypt(result);
}

function derialize(binary) {
    binary = encryptWorker.decrypt(binary);

    let binaryData = binary.slice(fillLen);
    let cidBuf = binaryData.slice(0, 32);
    let typeBuf = binaryData.slice(38, 39);
    let data = binaryData.slice(39);
    return {
        cid: cidBuf.toString('ascii'),
        type: typeBuf[0],
        data: data,
    };
}

// const payload = { cid: '79d309c9e17b44fc9e1425ed5fe92d31', type: 1, data: Buffer.from([1, 2, 3, 4]) };
// let result = serialize(payload);
// console.log(result);
// let parseObj = derialize(result);
// console.log(parseObj);

// let buf = Buffer.from([0x05, 0x06, 0x07]);

// console.log(buf.readUIntBE(0, 2));

exports.serialize = serialize;
exports.derialize = derialize;

exports.INIT_FRAME = 0;
exports.STREAM_FRAME = 1;
exports.FIN_FRAME = 2;
exports.RST_FRAME = 3;
exports.EST_FRAME = 4;

// ping pong
exports.PING_FRAME = 6;
exports.PONG_FRAME = 9;
