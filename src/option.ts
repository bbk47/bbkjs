import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkgJson = require('../package.json') as { version: string };
const cwd = process.cwd();

export interface TunnelOpts {
    protocol: string;
    secure: boolean;
    host: string;
    port: number;
    path: string;
    method: string;
    password: string;
}

export interface AppOptions {
    mode: 'client' | 'server';
    method: string;
    password: string;
    listenAddr: string;
    listenPort: number;
    listenHttpPort?: number;
    logLevel: string;
    logFile?: string;
    workMode: string;
    workPath: string;
    sslKey?: string;
    sslCrt?: string;
    ping?: boolean;
    tunnelOpts: TunnelOpts;
}

const defaultServerOpts: Partial<AppOptions> = {
    mode: 'server',
    method: 'aes-256-cfb',
    password: 'p@ssword',
    listenAddr: '127.0.0.1',
    listenPort: 5900,
    logLevel: 'info',
    workMode: 'ws',
    workPath: '/wss',
};

const defaultClientOpts: Partial<AppOptions> = {
    mode: 'client',
    listenAddr: '127.0.0.1',
    listenPort: 1090,
    logLevel: 'info',
    tunnelOpts: {
        protocol: 'ws',
        secure: false,
        host: '127.0.0.1',
        port: 5900,
        path: '/wss',
        method: 'aes-256-cfb',
        password: 'p@ssword',
    },
    ping: false,
};

const program = new Command();
program.version(pkgJson.version).option('-c --config <json file>', 'config file').parse(process.argv);

let options = program.opts() as { config?: string } & Partial<AppOptions>;

if (options.config) {
    const configfile = path.resolve(cwd, options.config);
    try {
        options = JSON.parse(fs.readFileSync(configfile, 'utf8')) as AppOptions;
    } catch (_err) {
        console.log(`load config file ${configfile} failed.`);
    }
} else {
    throw new Error('missing config file!');
}

if (options.sslKey) {
    options.sslKey = fs.readFileSync(path.resolve(cwd, options.sslKey), 'utf8');
    options.sslCrt = fs.readFileSync(path.resolve(cwd, options.sslCrt!), 'utf8');
}

const useOpts: AppOptions = {} as AppOptions;

if (options.mode === 'client') {
    Object.assign(useOpts, defaultClientOpts, options);
} else if (options.mode === 'server') {
    Object.assign(useOpts, defaultServerOpts, options);
} else {
    throw new Error(`unsupport mode: ${options.mode}`);
}

export default useOpts;
