import * as net from 'net';
import Server from '../../src/Server';
import Client from '../../src/Client';
import { getFreePort } from './ports';

export function startEchoServer(host = '127.0.0.1', port = 0) {
    return new Promise<{ server: net.Server; host: string; port: number; close: () => Promise<void> }>((resolve, reject) => {
        const server = net.createServer((socket) => {
            socket.pipe(socket);
        });
        server.once('error', reject);
        server.listen(port, host, () => {
            resolve({
                server,
                host,
                port: (server.address() as net.AddressInfo).port,
                close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
            });
        });
    });
}

function closeNetServer(server: net.Server | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (!server || !server.listening) { resolve(); return; }
        server.close(() => resolve());
    });
}

export async function startBbkServer(config: Record<string, unknown>) {
    if (!config.listenPort) {
        config.listenPort = await getFreePort(config.listenAddr as string);
    }
    const app = new Server(config as any);
    app.bootstrap();
    return {
        app,
        port: config.listenPort as number,
        close: () => closeNetServer((app as any)._server),
    };
}

export async function startBbkClient(config: Record<string, unknown>) {
    if (!config.listenPort) {
        config.listenPort = await getFreePort(config.listenAddr as string);
    }
    const app = new Client(config as any);
    app.bootstrap();
    return {
        app,
        port: config.listenPort as number,
        close: async () => {
            if ((app as any)._stubclient) (app as any)._stubclient.close();
            const servers: net.Server[] = (app as any)._proxyServers ?? [];
            await Promise.all(servers.map((s) => closeNetServer(s)));
        },
    };
}

export function waitForTunnel(clientApp: Client, timeoutMs = 10000): Promise<void> {
    return Promise.race([
        (clientApp as any).setupEnv(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tunnel setup timeout')), timeoutMs)),
    ]);
}
