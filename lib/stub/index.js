const EventEmitter = require('events');
const protocol = require('../protocol/index');

const BbkStream = require('./stream');

class StubWorker extends EventEmitter {
    constructor(tsport, serializer) {
        super();
        this.tsport = tsport;
        this._serializer = serializer;
        this._streams = {};
        this._seq = 0;
        this.bindEvents();
    }

    sendPacket(binarydata) {
        this.tsport.sendPacket(binarydata);
    }
    sendFrame(frame) {
        try {
            if (this.status === 'closed') return;
            protocol.frameSegment(frame, (tinyframe) => {
                const encData = this._serializer.serialize(tinyframe);
                // console.info(`write tunnel cid:${frame.cid}, data[${encData.length}]bytes, real data:${tinyframe.data.length}, type:${tinyframe.type}`);
                // console.log('write tunnel real data===>',encData.length);
                this.sendPacket(encData);
            });
        } catch (err) {
            this.onError(err);
        }
    }
    bindEvents() {
        this.tsport.bindEvents(this.dataListener.bind(this), this.onError.bind(this), this.onClose.bind(this));
    }
    createStream(streamId, addr) {
        const self = this;
        const duplex_stream = new BbkStream(function(chunk) {
            // 检查是否是窗口更新帧（4字节数据）
            if (chunk.length === 4) {
                self.sendFrame({ cid: streamId, type: protocol.WINDOW_UPDATE_FRAME, data: chunk });
            } else {
                self.sendFrame({ cid: streamId, type: protocol.STREAM_FRAME, data: chunk });
            }
        });
        duplex_stream.cid = streamId;
        duplex_stream.addr = addr;
        return duplex_stream;
    }
    startStream(addrData, callback) {
        this._seq++;
        if ((this._seq ^ 0x7fffffff) === 0) {
            // reset seq loop
            this._seq = 1;
        }
        const streamId = this._seq;
        const stream = this.createStream(streamId, addrData);
        const respFrame = { cid: stream.cid, type: protocol.INIT_FRAME, data: addrData };
        // console.log('====>++', respFrame.cid);
        this.sendFrame(respFrame);
        this._streams[streamId] = stream;
        callback(stream);
    }
    setReady(stream) {
        const respFrame = { cid: stream.cid, type: protocol.EST_FRAME, data: stream.addr };
        this.sendFrame(respFrame);
    }
    resetStream(streamId) {
        const respFrame = { cid: streamId, type: protocol.RST_FRAME, data: Buffer.from([0x1, 0x2]) };
        delete this._streams[streamId];
        this.sendFrame(respFrame);
    }
    closeStream(streamId) {
        const respFrame = { cid: streamId, type: protocol.FIN_FRAME, data: Buffer.from([0x1, 0x1]) };
        delete this._streams[streamId];
        this.sendFrame(respFrame);
    }
    emitStreamEvent(stream) {
        stream.on('error', (err) => {
            this.resetStream(stream.cid);
        });
        stream.on('close', () => {
            this.closeStream(stream.cid);
        });
        this._streams[stream.cid] = stream;
        this.emit('stream', stream, stream.addr);
    }
    dataListener(packet) {
        try {
            // console.log('stream count:', Object.keys(this._streams).length);
            const self = this;
            const frame = this._serializer.derialize(packet);
            // console.info(`read  tunnel cid:${frame.cid}, data[${packet.length}]bytes, real data:${frame.data.length} type:${frame.type}`);
            if (frame.type === protocol.PING_FRAME) {
                const buff = Buffer.concat([frame.data, Buffer.from(Date.now() + '')]);
                const respFrame = { cid: frame.cid, type: protocol.PONG_FRAME, data: buff };
                this.sendFrame(respFrame);
            } else if (frame.type === protocol.PONG_FRAME) {
                self.emit('pong', { up: frame.atime - frame.stime, down: Date.now() - frame.atime });
            } else if (frame.type === protocol.INIT_FRAME) {
                const server_stream = self.createStream(frame.cid, frame.data); // cid as streamId
                this.emitStreamEvent(server_stream);
            } else if (frame.type === protocol.EST_FRAME) {
                const client_stream = self._streams[frame.cid]; // cid as streamId
                if (!client_stream) {
                    self.resetStream(frame.cid);
                    return;
                }
                this.emitStreamEvent(client_stream);
            } else if (frame.type === protocol.STREAM_FRAME) {
                // console.log('====handle data producer====');
                const existStream = this._streams[frame.cid];
                if (!existStream) {
                    this.resetStream(frame.cid); // reset remote
                    return;
                }
                existStream.produce(frame.data);
            } else if (frame.type === protocol.WINDOW_UPDATE_FRAME) {
                const existStream = this._streams[frame.cid];
                if (!existStream) {
                    this.resetStream(frame.cid);
                    return;
                }
                // 解析窗口更新字节数
                const updateBytes = (frame.data[0] << 24) + (frame.data[1] << 16) + (frame.data[2] << 8) + frame.data[3];
                existStream.handleWindowUpdate(updateBytes);
            } else if (frame.type === protocol.FIN_FRAME) {
                // console.log('close stream frame====');
                const existStream = this._streams[frame.cid];
                if (existStream) {
                    delete this._streams[frame.cid];
                    existStream.destroy();
                }
            } else if (frame.type === protocol.RST_FRAME) {
                // console.log('close stream frame====');
                const existStream = this._streams[frame.cid];
                if (existStream) {
                    delete this._streams[frame.cid];
                    existStream.destroy();
                }
            } else {
                console.log('exception invalid frame=');
            }
        } catch (error) {
            //ignore protocol error
            console.log('error===>', error);
            // this.logger.fatal(`client decrypt or derialize message falied!`);
        }
    }
    onError(err) {
        this.emit('error', err);
        this.close();
    }
    onClose(code) {
        this.status = 'closed';
        this.emit('close', code);
    }
    close(err) {
        this.status = 'closed';
        Object.values(this._streams).forEach((temp) => temp.destroy(err));
    }

    ping() {
        const respFrame = { cid: 0, type: protocol.PING_FRAME, data: Buffer.from(Date.now() + '') };
        this.sendFrame(respFrame);
    }
}

module.exports = StubWorker;
