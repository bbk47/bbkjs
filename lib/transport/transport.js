const { websocketSend, tcpsocketSend, bindWebsocket, bindStreamSocket } = require('./helper');

class Transport {
    constructor(opts) {
        this.type = opts.type;
        this.conn = opts.conn;
    }
    sendPacket(binarydata) {
        if (this.type === 'ws') {
            websocketSend(this.conn, binarydata);
        } else {
            tcpsocketSend(this.conn, binarydata);
        }
    }
    bindEvents(onData, onError, onClose) {
        if (this.type === 'ws') {
            bindWebsocket(this.conn, onData, onError, onClose);
        } else {
            bindStreamSocket(this.conn, onData, onError, onClose);
        }
    }

    close() {
        try {
            this.conn.close();
        } catch (err) {
            // ignore
        }
    }
}

module.exports = Transport;
