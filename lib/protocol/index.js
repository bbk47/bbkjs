exports.INIT_FRAME = 0;
exports.STREAM_FRAME = 1;
exports.FIN_FRAME = 2;
exports.RST_FRAME = 3;
exports.EST_FRAME = 4;

// ping pong
exports.PING_FRAME = 6;
exports.PONG_FRAME = 9;

/**
 * // required: cid, type,  data
 * @param {*} frame
 * |<-version[1]->|<--cidLen[1]-->|<---(cid)---->|<--type[1]-->|<--dataLen[2]-->|<-------data------>|
 * |-----s1 ------|-------s2------|-----s3 ------|-------s4----|-------s5 ------|--------s6---------|
 * @returns
 */
function encode(frame) {
    // version, cid, data
    const version = frame.version || 1;
    const cidLen = frame.cid.length;
    const dataLen = frame.data.length;
    let verBuf = Buffer.from([version]); // s1
    let cidLenBuf = Buffer.from([cidLen & 0xff]); //  s2
    let cidBuf = Buffer.from(frame.cid); // s3
    let typeBuf = Buffer.from([frame.type]); // s4
    let dataLenBuf = Buffer.from([dataLen >> 8, dataLen & 0xff]); // s5

    const buflist = [verBuf, cidLenBuf, cidBuf, typeBuf, dataLenBuf, frame.data];

    const result = Buffer.concat(buflist);
    return result;
}

function decode(binaryData) {
    try {
        let version = binaryData[0]; // s1
        let cidLen = binaryData[1]; // s2
        let cidBuf = binaryData.slice(2, cidLen + 2); // s3
        let type = binaryData[cidLen + 2]; // s4
        let dataLen = (binaryData[cidLen + 3] << 8) + binaryData[cidLen + 4]; // s5
        const startIndex = cidLen + 5;
        let data = binaryData.slice(startIndex, dataLen + startIndex); // s6: data
        var frame = {
            version: version,
            cid: cidBuf.toString('ascii'),
            type: type,
            data: data,
        };
        if (type === 0x6) {
            frame.stime = parseInt(data.slice(0, 13).toString('ascii'));
        } else if (type === 0x9) {
            frame.stime = parseInt(data.slice(0, 13).toString('ascii'));
            frame.atime = parseInt(data.slice(13, 26).toString('ascii'));
        }
        return frame;
    } catch (err) {
        // console.log(err);
        throw Error('Protocol error!');
    }
}

if (require.main === module) {
    const payload = { cid: '79d309c9e17b44fc9e1425ed5fe92d31', type: 1, data: Buffer.from([1, 2, 3, 4]) };
    console.log('payload===');
    console.log(payload);
    let result = encode(payload, 2);
    console.log(result);
    let parseObj = decode(result);
    console.log(parseObj);
}

exports.encode = encode;
exports.decode = decode;
exports.frameSegment = require('./segment')
