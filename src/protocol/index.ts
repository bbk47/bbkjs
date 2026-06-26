import * as crypto from 'crypto';
import frameSegment from './segment';

export const INIT_FRAME = 0;
export const STREAM_FRAME = 1;
export const FIN_FRAME = 2;
export const RST_FRAME = 3;
export const EST_FRAME = 4;
export const WINDOW_UPDATE_FRAME = 5;
export const PING_FRAME = 6;
export const UDP_INIT_FRAME = 7;
export const PONG_FRAME = 9;

export interface Frame {
    version?: number;
    type: number;
    cid: number;
    data: Buffer;
    stime?: number;
    atime?: number;
}

/**
 * mask 字节防 ssl 证书被利用
 * |<--mask(rand)-->|<-version[1]->|<--type[1]-->|<---cid--->|<-------data------>|
 * |-------2--------|-------1 -----|-------1-----|-----4-----|-------------------|
 */
export function encode(frame: Frame): Buffer {
    const randBytes = crypto.randomBytes(2);
    const version = frame.version ?? 1;
    const verBuf = Buffer.from([version]);
    const typeBuf = Buffer.from([frame.type]);
    const cidVal = frame.cid;
    const cidBuf = Buffer.from([cidVal >> 24, cidVal >> 16, cidVal >> 8, cidVal & 0xff]);
    return Buffer.concat([randBytes, verBuf, typeBuf, cidBuf, frame.data]);
}

export function decode(binaryData: Buffer): Frame {
    try {
        const buf = binaryData.slice(2);
        const version = buf[0];
        const type = buf[1];
        const cidBuf = buf.slice(2, 6);
        const cid = (cidBuf[0] << 24) + (cidBuf[1] << 16) + (cidBuf[2] << 8) + cidBuf[3];
        const data = buf.slice(6);
        const frame: Frame = { version, type, cid, data };
        if (type === PING_FRAME) {
            frame.stime = parseInt(data.slice(0, 13).toString('ascii'));
        } else if (type === PONG_FRAME) {
            frame.stime = parseInt(data.slice(0, 13).toString('ascii'));
            frame.atime = parseInt(data.slice(13, 26).toString('ascii'));
        }
        return frame;
    } catch (_err) {
        throw new Error('Protocol error!');
    }
}

export { frameSegment };
