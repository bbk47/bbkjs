const EventEmitter = require('events');
const protocol = require('../protocol/index');
const BbkStream = require('@bbk47/toolbox').BbkStream;

// 底层单连接写缓冲高水位：超过则暂停灌帧，等待 drain，避免 socket 缓冲无限膨胀
const SOCKET_HIGH_WATER = 1 * 1024 * 1024; // 1MB

class StubWorker extends EventEmitter {
    constructor(tsport, serializer) {
        super();
        this.tsport = tsport;
        this._serializer = serializer;
        this._streams = {};
        this._udpSessions = {};
        this._seq = 0;

        // 发送调度：控制帧高优先队列 + 各流数据队列（加权轮询）
        this._ctrlQueue = [];
        this._dataQueues = new Map(); // cid -> [frame]
        this._rr = []; // 轮询顺序的 cid 列表
        this._draining = false;
        this._drainWaiting = false;

        this.bindEvents();
    }

    // ===================== 发送调度（背压驱动） =====================

    _enqueueCtrl(frame) {
        this._ctrlQueue.push(frame);
        this._kick();
    }

    _enqueueData(cid, frame) {
        let q = this._dataQueues.get(cid);
        if (!q) {
            q = [];
            this._dataQueues.set(cid, q);
            this._rr.push(cid);
        }
        q.push(frame);
        this._kick();
    }

    _kick() {
        if (this._draining || this._drainWaiting) return;
        this._draining = true;
        this._drainLoop();
    }

    _drainLoop() {
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

    _nextFrame() {
        if (this._ctrlQueue.length > 0) {
            return this._ctrlQueue.shift();
        }
        let count = this._rr.length;
        while (count-- > 0) {
            const cid = this._rr.shift();
            const q = this._dataQueues.get(cid);
            if (q && q.length > 0) {
                const frame = q.shift();
                if (q.length > 0) {
                    this._rr.push(cid); // 还有数据，排到队尾（公平）
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

    // 尽量定位底层连接以观察背压（ws: bufferedAmount，net/tls: writableLength）
    _underlyingConn() {
        const cands = [this.tsport && this.tsport.conn, this.tsport && this.tsport.socket, this.tsport && this.tsport.ws, this.tsport];
        for (const c of cands) {
            if (c && (typeof c.bufferedAmount === 'number' || typeof c.writableLength === 'number')) {
                return c;
            }
        }
        return null;
    }

    _isBackpressured() {
        const conn = this._underlyingConn();
        if (!conn) return false;
        if (typeof conn.bufferedAmount === 'number') {
            return conn.bufferedAmount > SOCKET_HIGH_WATER; // websocket
        }
        if (typeof conn.writableLength === 'number') {
            return conn.writableLength > SOCKET_HIGH_WATER; // net.Socket / tls
        }
        return false;
    }

    _waitDrain() {
        if (this._drainWaiting) return;
        this._drainWaiting = true;
        const conn = this._underlyingConn();
        const resume = () => {
            if (this.status === 'closed') return;
            this._drainWaiting = false;
            this._kick();
        };
        if (conn && typeof conn.once === 'function' && typeof conn.write === 'function') {
            conn.once('drain', resume); // socket/tls 原生背压
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

    sendPacket(binarydata) {
        try {
            this.tsport.sendPacket(binarydata);
        } catch (err) {
            if (this.status === 'closed') return;
            this.onError(err);
        }
    }

    _sendFrameReally(frame) {
        protocol.frameSegment(frame, (tinyframe) => {
            const encData = this._serializer.serialize(tinyframe);
            this.sendPacket(encData);
        });
    }

    // STREAM/FIN/RST 必须保持单流内顺序 -> 走每流数据队列；
    // 其余（INIT/EST/WINDOW_UPDATE/PING/PONG）走高优先队列，避免被大流量阻塞。
    _sendFrame(frame) {
        const t = frame.type;
        if (t === protocol.STREAM_FRAME || t === protocol.FIN_FRAME || t === protocol.RST_FRAME) {
            this._enqueueData(frame.cid, frame);
        } else {
            this._enqueueCtrl(frame);
        }
    }

    bindEvents() {
        this.tsport.bindEvents(this.dataListener.bind(this), this.onError.bind(this), this.onClose.bind(this));
    }

    // ===================== 流管理 =====================

    createStream(streamId, addr) {
        const self = this;
        const duplex_stream = new BbkStream(
            function (chunk) {
                self._sendFrame({ cid: streamId, type: protocol.STREAM_FRAME, data: chunk });
            },
            function (length) {
                self._sendFrame({ cid: streamId, type: protocol.WINDOW_UPDATE_FRAME, data: Buffer.from([length >> 24, length >> 16, length >> 8, length & 0xff]) });
            }
        );
        duplex_stream.cid = streamId;
        duplex_stream.addr = addr;
        return duplex_stream;
    }

    _cleanupStream(streamId) {
        // 仅解除流映射；其数据队列中可能仍有未发出的 FIN/RST，需保留以待发送完成，
        // 队列在 _nextFrame 中排空后会被惰性删除。
        delete this._streams[streamId];
    }

    closeStream(streamId) {
        this._sendFrame({ cid: streamId, type: protocol.FIN_FRAME, data: Buffer.from([0x1, 0x1]) });
    }

    resetStream(streamId) {
        this._sendFrame({ cid: streamId, type: protocol.RST_FRAME, data: Buffer.from([0x1, 0x2]) });
    }

    // 在流创建时即绑定生命周期，确保即便对端 EST 之前本端就 end()/destroy()，FIN/RST 也不会丢失
    _bindStreamLifecycle(stream) {
        const cid = stream.cid;
        stream.on('localfin', () => this.closeStream(cid)); // 本端可写侧优雅结束 -> FIN（半关）
        stream.on('localreset', () => this.resetStream(cid)); // 本端异常 -> RST（硬关）
        stream.on('error', () => {}); // 防止 Duplex error 冒泡为未捕获异常
        stream.on('close', () => this._cleanupStream(cid));
        this._streams[cid] = stream;
    }

    startStream(addrData) {
        this._seq++;
        if ((this._seq ^ 0x7fffffff) === 0) {
            this._seq = 1; // reset seq loop
        }
        const streamId = this._seq;
        const stream = this.createStream(streamId, addrData);
        this._bindStreamLifecycle(stream);
        this._sendFrame({ cid: stream.cid, type: protocol.INIT_FRAME, data: addrData });
        return stream;
    }

    // ===================== UDP session 管理（客户端发起） =====================

    startUdpSession(onDatagram) {
        this._seq++;
        if ((this._seq ^ 0x7fffffff) === 0) this._seq = 1;
        const cid = this._seq;
        this._udpSessions[cid] = { onDatagram };
        this._sendFrame({ cid, type: protocol.UDP_INIT_FRAME, data: Buffer.alloc(0) });
        return cid;
    }

    // 服务端调用：注册 UDP session handler 并回送 EST 通知客户端就绪
    openUdpSession(cid, onDatagram) {
        this._udpSessions[cid] = { onDatagram };
        this._sendFrame({ cid, type: protocol.EST_FRAME, data: Buffer.alloc(0) });
    }

    // 向对端发送一个 UDP 数据报：[2B addr_len][socks5_addr][payload]
    sendUdpDatagram(cid, addrBuf, payload) {
        if (!this._udpSessions[cid]) return;
        const lenBuf = Buffer.from([addrBuf.length >> 8, addrBuf.length & 0xff]);
        const data = Buffer.concat([lenBuf, addrBuf, payload]);
        this._sendFrame({ cid, type: protocol.STREAM_FRAME, data });
    }

    closeUdpSession(cid) {
        if (!this._udpSessions[cid]) return;
        delete this._udpSessions[cid];
        this._sendFrame({ cid, type: protocol.RST_FRAME, data: Buffer.from([0x1, 0x2]) });
    }

    setReady(stream) {
        this._sendFrame({ cid: stream.cid, type: protocol.EST_FRAME, data: stream.addr });
    }

    // ===================== 收包处理 =====================

    dataListener(packet) {
        try {
            const frame = this._serializer.derialize(packet);
            if (frame.type === protocol.PING_FRAME) {
                const buff = Buffer.concat([frame.data, Buffer.from(Date.now() + '')]);
                this._sendFrame({ cid: frame.cid, type: protocol.PONG_FRAME, data: buff });
            } else if (frame.type === protocol.PONG_FRAME) {
                this.emit('pong', { up: frame.atime - frame.stime, down: Date.now() - frame.atime });
            } else if (frame.type === protocol.UDP_INIT_FRAME) {
                this._udpSessions[frame.cid] = null; // placeholder，等 openUdpSession 填充
                this.emit('udp-session', frame.cid);
            } else if (frame.type === protocol.INIT_FRAME) {
                const server_stream = this.createStream(frame.cid, frame.data);
                this._bindStreamLifecycle(server_stream);
                this.emit('stream', server_stream, server_stream.addr);
            } else if (frame.type === protocol.EST_FRAME) {
                if (this._udpSessions[frame.cid] !== undefined) {
                    // UDP session 就绪通知，客户端无需额外处理
                    return;
                }
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
                if (existStream) {
                    existStream.remoteFinish();
                }
            } else if (frame.type === protocol.RST_FRAME) {
                if (this._udpSessions[frame.cid] !== undefined) {
                    delete this._udpSessions[frame.cid];
                    return;
                }
                const existStream = this._streams[frame.cid];
                if (existStream) {
                    existStream.remoteReset();
                }
            } else {
                this.emit('protocolError', new Error('unexpect frame type:' + frame.type));
            }
        } catch (error) {
            this.emit('protocolError', error);
        }
    }

    onError(err) {
        this.emit('error', err);
        this.close(err);
    }

    onClose(code) {
        this.emit('close', code);
        this.close();
    }

    close(err) {
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
            this.tsport.close && this.tsport.close();
        } catch (e) {
            // ignore
        }
    }

    ping() {
        this._sendFrame({ cid: 0, type: protocol.PING_FRAME, data: Buffer.from(Date.now() + '') });
    }
}

module.exports = StubWorker;
