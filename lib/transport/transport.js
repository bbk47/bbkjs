const EventEmitter = require('events');
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
        frameSegment(frame, (tinyframe) => {
            try {
                const encData = this._serializer.serialize(tinyframe);
                this.sendPacket(encData);
            } catch (err) {
                this.emit('error', err);
                this.close();
            }
        });
    }
    bindEvents() {
        const listeners = [this.dataListener.bind(this), this.onError.bind(this), this.onClose.bind(this)];
        if (this.type === 'ws') {
            bindWebsocket(this.socket, ...listeners);
        } else {
            bindStreamSocket(this.socket, ...listeners);
        }
    }
    startStream(cid, addrData) {
        // console.log('startstream===>', cid);
        const respFrame = { cid: cid, type: protocol.INIT_FRAME, data: addrData };
        this.sendFrame(respFrame);
    }
    setReady(stream) {
        // console.log('set ready====>',stream.cid);
        const respFrame = { cid: stream.cid, type: protocol.EST_FRAME, data: stream.addrData };
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
    dataListener(packet) {
        try {
            console.log('stream count:', Object.keys(this._streams).length);
            console.log('===addr:', Object.values(this._streams).map(temp=>temp.remoteaddr))
            // console.log('datalistenersss====>')
            const self = this;
            const frame = this._serializer.derialize(packet);
            // console.log('datalistener222====>',frame.type);
            // this.logger.debug(`read. ws tunnel cid:${frame.cid}, data[${packet.length}]bytes`);
            if (frame.type === protocol.PING_FRAME) {
                const now = Date.now();
                const buff = Buffer.concat([frame.data, Buffer.from(now + '')]);
                const respFrame = { cid: frame.cid, type: protocol.PONG_FRAME, data: buff };
                // console.log('pong...');
                this.sendFrame(respFrame);
            } else if (frame.type === protocol.PONG_FRAME) {
                // console.log('pong===>');
                // const now = Date.now();
                // const buff = Buffer.concat([frame.data, Buffer.from(now + '')]);
                // const respFrame = { cid: frame.cid, type: protocol.PONG_FRAME, data: buff };
                // console.log('pong...');
                const now = Date.now();
                const upUst = frame.atime - frame.stime;
                const downUst = now - frame.atime;
                self.emit('pong', { up: upUst, down: downUst });
                // this.sendFrame(respFrame);
            } else if (frame.type === protocol.INIT_FRAME || frame.type === protocol.EST_FRAME) {
                // console.log('init or est frame')
                const duplex_stream = new BbkStream(
                    frame.cid,
                    function (chunk) {
                        const respFrame = { cid: duplex_stream.cid, type: protocol.STREAM_FRAME, data: chunk };
                        self.sendFrame(respFrame);
                    },
                    frame.data,
                );
                duplex_stream.on('close', (err) => {
                    self.closeStream(duplex_stream);
                });
                duplex_stream.on('error', (err) => {
                    self.resetStream(duplex_stream);
                });
                this._streams[frame.cid] = duplex_stream;
                // console.log('======>>_streamListener');
                this.emit('stream', duplex_stream, frame.data);
            } else if (frame.type === protocol.STREAM_FRAME) {
                // console.log('====handle data producer====');
                const existStream = this._streams[frame.cid];
                existStream.produce(frame.data);
            } else if (frame.type === protocol.FIN_FRAME) {
                console.log('close stream frame====');
                const existStream = this._streams[frame.cid];
                if (existStream) {
                    existStream.destroy();
                } else {
                    // stream missing.
                }
                delete this._streams[frame.cid];
            } else if (frame.type === protocol.RST_FRAME) {
                console.log('close stream frame====');
                const existStream = this._streams[frame.cid];
                if (existStream) {
                    existStream.destroy(Error('reset by peer!'));
                } else {
                    // stream missing.
                }
                delete this._streams[frame.cid];
            } else {
                console.log('exception');
            }
        } catch (error) {
            // protocol error
            console.log(error);
            // this.logger.fatal(`client decrypt or derialize message falied!`);
        }
    }
    onError(err) {
        this.emit('error', err);
    }
    onClose() {
        this.emit('close');
    }
    close(err) {
        if (this.type === 'ws') {
            this.socket.close();
        } else {
            this.socket.end();
        }
    }

    ping() {
        const respFrame = { cid: PING_CID, type: protocol.PING_FRAME, data: Buffer.from(Date.now() + '') };
        this.sendFrame(respFrame);
    }
}

module.exports = Transport;
