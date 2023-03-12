const Duplex = require('stream').Duplex;

class BbkStream extends Duplex {
    constructor(writerFn) {
        super();
        this.writerFn = writerFn;
        this.cache = Buffer.from([]);
    }

    produce(rawData) {
        if (!rawData) {
            console.log('no rawData====', rawData);
        }
        this.cache = Buffer.concat([this.cache, rawData]);
        this.read();
    }

    _write(chunk, encoding, callback) {
        // The underlying source only deals with strings
        this.writerFn(chunk, this);
        callback();
    }
    _read(size) {
        size = size || 1024 * 4;
        const rawdata = this.cache.subarray(0, size);
        this.push(rawdata);
        this.cache = this.cache.subarray(size);
    }
}

module.exports = BbkStream;
