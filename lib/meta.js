/**
 *
 * @param {*} frame
 * |<------2(length)------->|<-------36(id)----->|<--1(type)-->|<------------data------------->|
 *
 * @returns
 */
function serialize(frame) {
    let cidBuf = Buffer.from(frame.cid);
    let typeBuf = Buffer.from([frame.type]);
    let buf = Buffer.alloc(2);
    buf.writeUIntBE(frame.data.length + 37, 0, 2);
    return Buffer.concat([buf, cidBuf, typeBuf, frame.data]);
}

function derialize(binaryData) {
    let length = binaryData.readUIntBE(0, 2);
    let cidBuf = binaryData.slice(2, 38);
    let typeBuf = binaryData.slice(38, 39);
    let data = binaryData.slice(39);
    return {
        length: length,
        cid: cidBuf.toString('ascii'),
        type: typeBuf[0],
        data: data,
    };
}

// const payload = { cid: '79d309c9-e17b-44fc-9e14-25ed5fe92d31', type: 1, data: Buffer.from([1, 2, 3, 4]) };
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
