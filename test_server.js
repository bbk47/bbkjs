// server.js
const net = require('net');
const BbkStream = require('./lib/stub/stream');

const server = net.createServer(socket => {
    console.log('🔗 新连接');

    const stream = new BbkStream(
        (chunk) => {
            // 模拟网络传输，收到 chunk 就放入缓存区
            stream.produce(chunk);
        },
        (windowUpdateBytes) => {
            // 模拟 window update
            stream.handleWindowUpdate(windowUpdateBytes);
        }
    );

    socket.pipe(stream).pipe(socket);

    // 模拟读取数据，告诉对方可以再发多少
    stream.on('data', (chunk) => {
        console.log(`📥 读取数据: ${chunk.length} 字节`);
        setTimeout(() => {
            // 模拟慢速消费
            stream.handleWindowUpdate(chunk.length);
        }, 100); // 每100ms回报窗口更新
    });
});

server.listen(8000, () => {
    console.log('🟢 服务监听中 on port 8000');
});
