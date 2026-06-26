// client.js
const net = require('net');
const BbkStream = require('./lib/stub/stream');

const socket = net.connect(8000, '127.0.0.1', () => {
    console.log('🚀 已连接服务器');

    const stream = new BbkStream(
        (chunk) => {
            socket.write(chunk); // 发到服务端
        },
        (windowUpdateBytes) => {
            // 不做处理，server会主动回调 handleWindowUpdate
        }
    );

    socket.pipe(stream).pipe(socket);

    // 模拟不停发送数据
    const sendLargeData = () => {
        const chunk = Buffer.alloc(8 * 1024, 'x'); // 每次8KB
        const interval = setInterval(() => {
            const ok = stream.write(chunk);
            console.log('✉️ 写入流:', ok ? '✅ 成功' : '🟡 返回false');
        }, 10);
    };

    sendLargeData();
});
