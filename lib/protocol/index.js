const crypto = require('crypto');

exports.INIT_FRAME = 0;
exports.STREAM_FRAME = 1;
exports.FIN_FRAME = 2;
exports.RST_FRAME = 3;
exports.EST_FRAME = 4;

// ping pong
exports.PING_FRAME = 6;
exports.PONG_FRAME = 9;

/**
 * mask字节防ssl证书被利用, 如使用腾讯云免费证书、证书被窃取...
 * @param {*} stream frame
 * |<--mask(rand)-->|<-version[1]->|<--type[1]-->|<---cid--->|<-------data------>|
 * |-------2--------|-------1 -----|-------1-----|-----4-----|-------------------|
 * @returns
 */
function encode(frame) {
    // version, cid, data
    const randBytes = crypto.randomBytes(2);
    const version = frame.version || 1;
    let verBuf = Buffer.from([version]); // s1
    let typeBuf = Buffer.from([frame.type]); // s2
    const cidVal = frame.cid;
    let cidBuf = Buffer.from([cidVal >> 24, cidVal >> 16, cidVal >> 8, cidVal & 0xff]); // s3
    const buflist = [randBytes, verBuf, typeBuf, cidBuf, frame.data];

    const result = Buffer.concat(buflist);
    return result;
}

function decode(binaryData) {
    try {
        binaryData = binaryData.slice(2);
        let version = binaryData[0]; // s1
        let type = binaryData[1]; // s2
        let cidBuf = binaryData.slice(2, 6); // s3
        let cid = (cidBuf[0] << 24) + (cidBuf[1] << 16) + (cidBuf[2] << 8) + cidBuf[3];

        let data = binaryData.slice(6); // s4: data
        var frame = { version, type, cid, data };
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
    const payload = { cid: 21382813, type: 1, data: Buffer.from([1, 2, 3, 4]) };
    console.log('payload===');
    console.log(payload);
    let result = encode(payload);
    console.log(result);
    let parseObj = decode(result);
    console.log(parseObj);
}

exports.encode = encode;
exports.decode = decode;
exports.frameSegment = require('./segment');
