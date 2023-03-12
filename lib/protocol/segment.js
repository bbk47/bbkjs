const DATA_MAX_SIZE = 1024 * 2;

function frameSegment(frame, callback) {
    let offset = 0;
    let offset2 = 0;
    if (!frame.data || frame.data.length < DATA_MAX_SIZE) {
        callback(frame);
        return;
    }
    let len = frame.data.length;
    // 大帧拆分，最大为65535-39(2+1+36)
    while (true) {
        offset2 = offset + DATA_MAX_SIZE;
        if (offset2 > len) {
            offset2 = len;
        }
        let frame2 = Object.assign({}, frame);
        frame2.data = frame.data.slice(offset, offset2);
        callback(frame2);
        offset = offset2;
        if (offset2 === len) {
            break;
        }
    }
}

module.exports = frameSegment;
