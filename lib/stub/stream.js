const Duplex = require('stream').Duplex;

class BbkStream extends Duplex {
    constructor(writerFn) {
        super();
        this.writerFn = writerFn;
        this.cache = Buffer.from([]);
        this.windowSize = 32 * 1024; // 32KB窗口大小
        this.sentBytes = 0;
        this.ackBytes = 0;
        this.pendingData = [];
    }

    produce(rawData) {
        if (!rawData) {
            console.log('no rawData====', rawData);
        }
        this.cache = Buffer.concat([this.cache, rawData]);
        this.read();
    }

    _write(chunk, encoding, callback) {
        // 检查滑动窗口是否已满
        if (this.sentBytes - this.ackBytes >= this.windowSize) {
            // 窗口已满，将数据加入待发送队列
            this.pendingData.push({ chunk, callback });
            return;
        }
        
        // 窗口未满，直接发送
        this._sendData(chunk, callback);
    }
    
    _sendData(chunk, callback) {
        this.sentBytes += chunk.length;
        this.writerFn(chunk, this);
        callback();
        
        // 检查是否需要处理待发送队列
        this._processPendingData();
    }
    
    _processPendingData() {
        while (this.pendingData.length > 0 && 
               this.sentBytes - this.ackBytes < this.windowSize) {
            const { chunk, callback } = this.pendingData.shift();
            this._sendData(chunk, callback);
        }
    }
    
    // 处理窗口更新帧
    handleWindowUpdate(updateBytes) {
        this.ackBytes += updateBytes;
        this._processPendingData();
    }
    
    // 发送窗口更新帧
    sendWindowUpdate(bytes) {
        const updateData = Buffer.from([bytes >> 24, bytes >> 16, bytes >> 8, bytes & 0xff]);
        this.writerFn(updateData, this);
    }
    
    _read(size) {
        size = size || 1024 * 4;
        const rawdata = this.cache.subarray(0, size);
        this.push(rawdata);
        this.cache = this.cache.subarray(size);
        
        // 读取数据后，发送窗口更新
        if (rawdata.length > 0) {
            this.sendWindowUpdate(rawdata.length);
        }
    }
}

module.exports = BbkStream;
