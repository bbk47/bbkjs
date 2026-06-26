import type { Frame } from './index';

const DATA_MAX_SIZE = 1024 * 2;

function frameSegment(frame: Frame, callback: (f: Frame) => void): void {
    if (!frame.data || frame.data.length < DATA_MAX_SIZE) {
        callback(frame);
        return;
    }
    const len = frame.data.length;
    let offset = 0;
    while (true) {
        let offset2 = offset + DATA_MAX_SIZE;
        if (offset2 > len) {
            offset2 = len;
        }
        const frame2: Frame = { ...frame, data: frame.data.slice(offset, offset2) };
        callback(frame2);
        offset = offset2;
        if (offset2 === len) break;
    }
}

export default frameSegment;
