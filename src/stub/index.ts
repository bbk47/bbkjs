import { EventEmitter } from 'events';
import * as protocol from '../protocol/index';
import { BbkStream } from '@bbk47/toolbox';
import type { Transport } from '../transport';
import type { Serializer } from '../serializer';

interface BbkStreamEx extends BbkStream {
    cid: number;
    addr: Buffer;
}

const SOCKET_HIGH_WATER = 1 * 1024 * 1024; // 1MB

type AnyConn = { bufferedAmount?: number; writableLength?: number; once?: (ev: string, fn: () => void) => void; write?: unknown };

class StubWorker extends EventEmitter {
    tsport: Transport;
    private _serializer: Serializer;
    private _streams: Record<number, BbkStreamEx>;
    private _udpSessions: Record<number, { onDatagram: (addrBuf: Buffer, payload: Buffer) => void } | null>;
    private _seq: number;
    private _ctrlQueue: protocol.Frame[];
    private _dataQueues: Map<number, protocol.Frame[]>;
    private _rr: number[];
    private _draining: boolean;
    private _drainWaiting: boolean;
    status?: string;

    constructor(tsport: Transport, serializer: Serializer) {
        super();
        this.tsport = tsport;
        this._serializer = serializer;
        this._streams = {};
        this._udpSessions = {};
        this._seq = 0;
        this._ctrlQueue = [];
        this._dataQueues = new Map();
        this._rr = [];
        this._draining = false;
        this._drainWaiting = false;
        this.bindEvents();
    }

    // ===================== 发送调度（背压驱动） =====================

    private _enqueueCtrl(frame: protocol.Frame): void {
        this._ctrlQueue.push(frame);
        this._kick();
    }

    private _enqueueData(cid: number, frame: protocol.Frame): void {
        let q = this._dataQueues.get(cid);
        if (!q) {
            q = [];
            this._dataQueues.set(cid, q);
            this._rr.push(cid);
        }
        q.push(frame);
        this._kick();
    }

    private _kick(): void {
        if (this._draining || this._drainWaiting) return;
        this._draining = true;
        this._drainLoop();
    }

    private _drainLoop(): void {
        while (true) {
            if (this.status === 'closed') {
                this._draining = false;
                return;
            }
            if (this._isBackpressured()) {
                this._draining = false;
                this._waitDrain();
                return;
            }
            const frame = this._nextFrame();
            if (!frame) {
                this._draining = false;
                return;
            }
            this._sendFrameReally(frame);
        }
    }

    private _nextFrame(): protocol.Frame | null {
        if (this._ctrlQueue.length > 0) {
            return this._ctrlQueue.shift()!;
        }
        let count = this._rr.length;
        while (count-- > 0) {
            const cid = this._rr.shift()!;
            const q = this._dataQueues.get(cid);
            if (q && q.length > 0) {
                const frame = q.shift()!;
                if (q.length > 0) {
                    this._rr.push(cid);
                } else {
                    this._dataQueues.delete(cid);
                }
                return frame;
            } else {
                this._dataQueues.delete(cid);
            }
        }
        return null;
    }

    private _underlyingConn(): AnyConn | null {
        const cands: unknown[] = [this.tsport?.conn, (this.tsport as unknown as Record<string, unknown>)?.socket, (this.tsport as unknown as Record<string, unknown>)?.ws, this.tsport];
        for (const c of cands) {
            const conn = c as AnyConn;
            if (conn && (typeof conn.bufferedAmount === 'number' || typeof conn.writableLength === 'number')) {
                return conn;
            }
        }
        return null;
    }

    private _isBackpressured(): boolean {
        const conn = this._underlyingConn();
        if (!conn) return false;
        if (typeof conn.bufferedAmount === 'number') return conn.bufferedAmount > SOCKET_HIGH_WATER;
        if (typeof conn.writableLength === 'number') return conn.writableLength > SOCKET_HIGH_WATER;
        return false;
    }

    private _waitDrain(): void {
        if (this._drainWaiting) return;
        this._drainWaiting = true;
        const conn = this._underlyingConn();
        const resume = () => {
            if (this.status === 'closed') return;
            this._drainWaiting = false;
            this._kick();
        };
        if (conn && typeof conn.once === 'function' && typeof conn.write !== 'undefined') {
            conn.once('drain', resume);
        } else {
            const poll = () => {
                if (this.status === 'closed') return;
                if (this._isBackpressured()) {
                    setTimeout(poll, 5);
                } else {
                    resume();
                }
            };
            setTimeout(poll, 5);
        }
    }

    sendPacket(binarydata: Buffer): void {
        try {
            this.tsport.sendPacket(binarydata);
        } catch (err) {
            if (this.status === 'closed') return;
            this.onError(err as Error);
        }
    }

    private _sendFrameReally(frame: protocol.Frame): void {
        protocol.frameSegment(frame, (tinyframe) => {
            const encData = this._serializer.serialize(tinyframe);
            this.sendPacket(encData);
        });
    }

    private _sendFrame(frame: protocol.Frame): void {
        const t = frame.type;
        if (t === protocol.STREAM_FRAME || t === protocol.FIN_FRAME || t === protocol.RST_FRAME) {
            this._enqueueData(frame.cid, frame);
        } else {
            this._enqueueCtrl(frame);
        }
    }

    bindEvents(): void {
        this.tsport.bindEvents(this.dataListener.bind(this), this.onError.bind(this), this.onClose.bind(this));
    }

    // ===================== 流管理 =====================

    createStream(streamId: number, addr: Buffer): BbkStreamEx {
        const duplex_stream = new BbkStream(
            (chunk: Buffer) => {
                this._sendFrame({ cid: streamId, type: protocol.STREAM_FRAME, data: chunk });
            },
            (length: number) => {
                this._sendFrame({ cid: streamId, type: protocol.WINDOW_UPDATE_FRAME, data: Buffer.from([length >> 24, length >> 16, length >> 8, length & 0xff]) });
            }
        ) as BbkStreamEx;
        duplex_stream.cid = streamId;
        duplex_stream.addr = addr;
        return duplex_stream;
    }

    private _cleanupStream(streamId: number): void {
        delete this._streams[streamId];
    }

    closeStream(streamId: number): void {
        this._sendFrame({ cid: streamId, type: protocol.FIN_FRAME, data: Buffer.from([0x1, 0x1]) });
    }

    resetStream(streamId: number): void {
        this._sendFrame({ cid: streamId, type: protocol.RST_FRAME, data: Buffer.from([0x1, 0x2]) });
    }

    private _bindStreamLifecycle(stream: BbkStreamEx): void {
        const cid = stream.cid;
        stream.on('localfin', () => this.closeStream(cid));
        stream.on('localreset', () => this.resetStream(cid));
        stream.on('error', () => {});
        stream.on('close', () => this._cleanupStream(cid));
        this._streams[cid] = stream;
    }

    startStream(addrData: Buffer): BbkStreamEx {
        this._seq++;
        if ((this._seq ^ 0x7fffffff) === 0) this._seq = 1;
        const streamId = this._seq;
        const stream = this.createStream(streamId, addrData);
        this._bindStreamLifecycle(stream);
        this._sendFrame({ cid: stream.cid, type: protocol.INIT_FRAME, data: addrData });
        return stream;
    }

    setReady(stream: BbkStreamEx): void {
        this._sendFrame({ cid: stream.cid, type: protocol.EST_FRAME, data: stream.addr });
    }

    // ===================== UDP session 管理 =====================

    startUdpSession(onDatagram: (addrBuf: Buffer, payload: Buffer) => void): number {
        this._seq++;
        if ((this._seq ^ 0x7fffffff) === 0) this._seq = 1;
        const cid = this._seq;
        this._udpSessions[cid] = { onDatagram };
        this._sendFrame({ cid, type: protocol.UDP_INIT_FRAME, data: Buffer.alloc(0) });
        return cid;
    }

    openUdpSession(cid: number, onDatagram: (addrBuf: Buffer, payload: Buffer) => void): void {
        this._udpSessions[cid] = { onDatagram };
        this._sendFrame({ cid, type: protocol.EST_FRAME, data: Buffer.alloc(0) });
    }

    sendUdpDatagram(cid: number, addrBuf: Buffer, payload: Buffer): void {
        if (this._udpSessions[cid] === undefined) return;
        const lenBuf = Buffer.from([addrBuf.length >> 8, addrBuf.length & 0xff]);
        this._sendFrame({ cid, type: protocol.STREAM_FRAME, data: Buffer.concat([lenBuf, addrBuf, payload]) });
    }

    closeUdpSession(cid: number): void {
        if (this._udpSessions[cid] === undefined) return;
        delete this._udpSessions[cid];
        this._sendFrame({ cid, type: protocol.RST_FRAME, data: Buffer.from([0x1, 0x2]) });
    }

    // ===================== 收包处理 =====================

    dataListener(packet: Buffer): void {
        try {
            const frame = this._serializer.derialize(packet);
            if (frame.type === protocol.PING_FRAME) {
                const buff = Buffer.concat([frame.data, Buffer.from(Date.now() + '')]);
                this._sendFrame({ cid: frame.cid, type: protocol.PONG_FRAME, data: buff });
            } else if (frame.type === protocol.PONG_FRAME) {
                this.emit('pong', { up: frame.atime! - frame.stime!, down: Date.now() - frame.atime! });
            } else if (frame.type === protocol.UDP_INIT_FRAME) {
                this._udpSessions[frame.cid] = null;
                this.emit('udp-session', frame.cid);
            } else if (frame.type === protocol.INIT_FRAME) {
                const server_stream = this.createStream(frame.cid, frame.data);
                this._bindStreamLifecycle(server_stream);
                this.emit('stream', server_stream, server_stream.addr);
            } else if (frame.type === protocol.EST_FRAME) {
                if (this._udpSessions[frame.cid] !== undefined) return;
                const client_stream = this._streams[frame.cid];
                if (!client_stream) {
                    this.resetStream(frame.cid);
                    return;
                }
                this.emit('stream', client_stream, client_stream.addr);
            } else if (frame.type === protocol.STREAM_FRAME) {
                const udpSession = this._udpSessions[frame.cid];
                if (udpSession !== undefined) {
                    if (udpSession && typeof udpSession.onDatagram === 'function') {
                        const addrLen = (frame.data[0] << 8) + frame.data[1];
                        const addrBuf = frame.data.slice(2, 2 + addrLen);
                        const payload = frame.data.slice(2 + addrLen);
                        udpSession.onDatagram(addrBuf, payload);
                    }
                    return;
                }
                const existStream = this._streams[frame.cid];
                if (!existStream) {
                    this.resetStream(frame.cid);
                    return;
                }
                existStream.produce(frame.data);
            } else if (frame.type === protocol.WINDOW_UPDATE_FRAME) {
                const existStream = this._streams[frame.cid];
                if (!existStream) {
                    this.resetStream(frame.cid);
                    return;
                }
                const updateBytes = (frame.data[0] << 24) + (frame.data[1] << 16) + (frame.data[2] << 8) + frame.data[3];
                existStream.handleWindowUpdate(updateBytes);
            } else if (frame.type === protocol.FIN_FRAME) {
                const existStream = this._streams[frame.cid];
                if (existStream) existStream.remoteFinish();
            } else if (frame.type === protocol.RST_FRAME) {
                if (this._udpSessions[frame.cid] !== undefined) {
                    delete this._udpSessions[frame.cid];
                    return;
                }
                const existStream = this._streams[frame.cid];
                if (existStream) existStream.remoteReset();
            } else {
                this.emit('protocolError', new Error('unexpect frame type:' + frame.type));
            }
        } catch (error) {
            this.emit('protocolError', error);
        }
    }

    onError(err: Error): void {
        this.emit('error', err);
        this.close(err);
    }

    onClose(code?: number): void {
        this.emit('close', code);
        this.close();
    }

    close(err?: Error): void {
        if (this.status === 'closed') return;
        this.status = 'closed';
        Object.values(this._streams).forEach((temp) => {
            delete this._streams[temp.cid];
            temp.destroy(err);
        });
        this._udpSessions = {};
        this._dataQueues.clear();
        this._rr = [];
        this._ctrlQueue = [];
        try {
            this.tsport.close?.();
        } catch (_e) {
            // ignore
        }
    }

    ping(): void {
        this._sendFrame({ cid: 0, type: protocol.PING_FRAME, data: Buffer.from(Date.now() + '') });
    }
}

export default StubWorker;
