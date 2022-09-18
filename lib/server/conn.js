const { websocketSend, tcpsocketSend, bindWebsocket, bindStreamSocket } = require('../transport/index');

class TunnelConn {
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
        if (this.type === 'ws') {
            this.conn.close();
        } else {
            this.conn.end();
        }
    }
}

module.exports = TunnelConn;
