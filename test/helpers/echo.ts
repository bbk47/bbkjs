import * as net from 'net';
import * as dgram from 'dgram';

export interface EchoTarget {
    host: string;
    port: number;
    close: () => Promise<void>;
}

// startTcpEchoServer 起一个 TCP 回显目标：原样回写收到的字节。
export function startTcpEchoServer(host = '127.0.0.1'): Promise<EchoTarget> {
    return new Promise((resolve, reject) => {
        const server = net.createServer({ allowHalfOpen: true }, (socket) => {
            socket.on('error', () => socket.destroy());
            socket.pipe(socket);
        });
        server.once('error', reject);
        server.listen(0, host, () => {
            const { port } = server.address() as net.AddressInfo;
            resolve({
                host,
                port,
                close: () => new Promise<void>((res) => server.close(() => res())),
            });
        });
    });
}

// startUdpEchoServer 起一个 UDP 回显目标：把每个数据报原样回送给来源。
export function startUdpEchoServer(host = '127.0.0.1'): Promise<EchoTarget> {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        sock.once('error', reject);
        sock.on('message', (msg, rinfo) => {
            sock.send(msg, rinfo.port, rinfo.address);
        });
        sock.bind(0, host, () => {
            const { port } = sock.address();
            resolve({
                host,
                port,
                close: () => new Promise<void>((res) => sock.close(() => res())),
            });
        });
    });
}
