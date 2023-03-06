const EventEmitter = require('events');
const toolboxjs = require('@bbk47/toolbox');
const frameSegment = require('./segment');
const protocol = require('../protocol/index');

const { websocketSend, tcpsocketSend, bindWebsocket, bindStreamSocket } = require('./helper');
const BbkStream = require('./stream');

const PING_CID = '0'.repeat(32);

class Transport extends EventEmitter {
    constructor(type, socket) {
        super();
        this.type = type;
        this.socket = socket;
        this._serializer = null;
        this._streams = {};
        this.bindEvents();
    }

    setSerializer(serializer) {
        this._serializer = serializer;
    }
    sendPacket(binarydata) {
        if (this.type === 'ws') {
            websocketSend(this.socket, binarydata);
        } else {
            tcpsocketSend(this.socket, binarydata);
        }
    }
    sendFrame(frame) {
        try {
            frameSegment(frame, (tinyframe) => {
                const encData = this._serializer.serialize(tinyframe);
                this.sendPacket(encData);
            });
        } catch (err) {
            this.onError(err);
        }
    }
    bindEvents() {
        const listeners = [this.dataListener.bind(this), this.onError.bind(this), this.onClose.bind(this)];
        if (this.type === 'ws') {
            bindWebsocket(this.socket, ...listeners);
        } else {
            bindStreamSocket(this.socket, ...listeners);
        }
    }
    createStream(streamId, addr) {
        const self = this;
        const duplex_stream = new BbkStream(function (chunk) {
            self.sendFrame({ cid: streamId, type: protocol.STREAM_FRAME, data: chunk });
        });
        duplex_stream.cid = streamId;
        duplex_stream.addr = addr;
        return duplex_stream;
    }
    startStream(addrData, callback) {
        const streamId = toolboxjs.uuid();
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
    resetStream(stream) {
        const respFrame = { cid: stream.cid, type: protocol.RST_FRAME, data: Buffer.from([0x1, 0x2]) };
        this.sendFrame(respFrame);
    }
    closeStream(stream) {
        const respFrame = { cid: stream.cid, type: protocol.FIN_FRAME, data: Buffer.from([0x1, 0x2]) };
        this.sendFrame(respFrame);
    }
    emitStreamEvent(stream) {
        stream.on('close', (err) => {
            this.closeStream(stream);
        });
        this._streams[stream.cid] = stream;
        this.emit('stream', stream, stream.addr);
    }
    dataListener(packet) {
        try {
            // console.log('stream count:', Object.keys(this._streams).length);
            const self = this;
            const frame = this._serializer.derialize(packet);
            // this.logger.debug(`read. ws tunnel cid:${frame.cid}, data[${packet.length}]bytes`);
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
                    self.resetStream(client_stream);
                    return;
                }
                this.emitStreamEvent(client_stream);
            } else if (frame.type === protocol.STREAM_FRAME) {
                // console.log('====handle data producer====');
                const existStream = this._streams[frame.cid];
                if (!existStream) {
                    this.resetStream(existStream); // reset remote
                    return;
                }
                existStream.produce(frame.data);
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
                    existStream.destroy(Error('reset by peer!'));
                }
            } else {
                console.log('exception');
            }
        } catch (error) {
            //ignore protocol error
            console.log(error);
            // this.logger.fatal(`client decrypt or derialize message falied!`);
        }
    }
    onError(err) {
        this.emit('error', err);
        this.close();
    }
    onClose(code) {
        this.emit('close', code);
    }
    close(err) {
        if (this.type === 'ws') {
            this.socket.close();
        } else {
            this.socket.end();
        }
        Object.values(this._streams).forEach((temp) => {
            temp.destroy(err);
        });
    }

    ping() {
        const respFrame = { cid: PING_CID, type: protocol.PING_FRAME, data: Buffer.from(Date.now() + '') };
        this.sendFrame(respFrame);
    }
}

module.exports = Transport;