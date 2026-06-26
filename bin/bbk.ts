import options from '../src/option';
import { Client, Server } from '../src/index';

let app: Client | Server;

if (options.mode === 'client') {
    app = new Client(options);
} else if (options.mode === 'server') {
    app = new Server(options);
} else {
    console.log(`unsupport mode[${options.mode}]! must be in (client, server)`);
    process.exit(1);
}

app.bootstrap();
