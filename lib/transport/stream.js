const Duplex = require('stream').Duplex;
const toolboxjs = require('@bbk47/toolbox');
const socks5 = toolboxjs.socks5;

class BbkStream extends Duplex {
    constructor(cid, writerFn, addrData) {
        super();
        this.cid = cid;
        const addrInfo =socks5.parseSocks5Addr(addrData);
        this.remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
        this.writerFn = writerFn;
        this.addrData = addrData;
        this.cache = Buffer.from([]);
    }

    produce(rawData) {
        if(!rawData){
            console.log('no rawData====', rawData)
        }
        this.cache = Buffer.concat([this.cache, rawData]);
        this.read();
    }

    _write(chunk, encoding, callback) {
        // The underlying source only deals with strings
        this.writerFn(chunk);
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
