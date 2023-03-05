const Duplex = require('stream').Duplex;

class BbkStream extends Duplex {
    constructor(source, options) {
        super(options);
        this.__serializer = options.serializer;
        this.__tunnel = source;
    }

    _write(chunk, encoding, callback) {
        // The underlying source only deals with strings
        if (Buffer.isBuffer(chunk)) chunk = chunk.toString();
        this.__tunnel.writeSomeData(chunk);
        callback();
    }

    _read(size) {
        this[kSource].fetchSomeData(size, (data, encoding) => {
            this.push(Buffer.from(data, encoding));
        });
    }
    handleData() {
        if (frame.type === protocol.INIT_FRAME) {
            let rs = new Readable();
            rs._read = () => {};
            const targetObj = { dataCache: rs };
            const targetSocket = net.Socket();
            this._targetConnection[frame.cid] = targetObj;
            const addrInfo = socks5.parseSocks5Addr(frame.data);
            this.logger.info(`REQ REQUEST ===> ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            targetSocket.connect(addrInfo.dstPort, addrInfo.dstAddr, () => {
                this.logger.info(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
                targetObj.socket = targetSocket;
                targetObj.dataCache.pipe(targetSocket);
                const respFrame = { cid: frame.cid, type: protocol.EST_FRAME, data: frame.data };
                this.flusResponseFrame(tunconn, respFrame);
            });
            targetSocket.on('data', (data) => {
                // console.log('stream frame <<<<<=====')
                // console.log('target server data come! for cid:' + frame.cid);
                const respFrame = { cid: frame.cid, type: protocol.STREAM_FRAME, data: data };
                this.flusResponseFrame(tunconn, respFrame);
            });
            targetSocket.on('close', (hadError) => {
                this.logger.debug(`fire event[close] on target[${addrInfo.dstAddr}:${addrInfo.dstPort}]!hasError:${hadError}`);
                this.releaseTarget(frame);
                const respFrame = { cid: frame.cid, type: protocol.FIN_FRAME, data: Buffer.from([0, 1]) };
                this.flusResponseFrame(tunconn, respFrame);
            });
            targetSocket.on('error', (err) => {
                this.logger.error(`fire event[error] on target[${addrInfo.dstAddr}:${addrInfo.dstPort}]!message:${err.message}`);
                this.releaseTarget(frame);
                const respFrame = { cid: frame.cid, type: protocol.RST_FRAME, data: Buffer.from([0, 2]) };
                this.flusResponseFrame(tunconn, respFrame);
            });
        } else if (frame.type === protocol.STREAM_FRAME) {
            // console.log('stream frame===>')
            const targetObj = this._targetConnection[frame.cid];
            if (targetObj) {
                targetObj.dataCache.push(frame.data);
            } else {
                this.logger.debug('====STREAM_FRAME missing target connection!!');
            }
        } else if (frame.type === protocol.FIN_FRAME) {
            this.logger.debug('====FIN_FRAME from client, end target connection!');
            this.releaseTarget(frame);
        }
    }
}

module.exports = function (transport, serializer) {
    return {
        send,
    };
};
