const program = require('commander');
const fs = require('fs');
const path = require('path');
const pkgJson = require('../package.json');
const cwd = process.cwd();

const defaultServerOpts = {
    mode: 'server',
    method: 'aes-256-cfb', // local/server
    password: 'p@ssword', // local/server
    listenAddr: '127.0.0.1', // local/server
    listenPort: 5900, // local/server
    logLevel: 'info', // local/server
    workMode: 'ws',
    workPath: '/wss',
};

const defaultClientOpts = {
    mode: 'server',
    listenAddr: '127.0.0.1', // local/server
    listenPort: 1090, // local/server
    logLevel: 'info', // local/server
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

program.version(pkgJson.version).option('-c --config <json file>', 'config file, if exist, ignore command line args').parse(process.argv);

let options = program.opts();

if (options.config) {
    const configfile = path.resolve(cwd, options.config);
    try {
        options = require(configfile);
    } catch (err) {
        console.log(`load config file ${configfile} failed.`);
    }
} else {
    throw Error('missing config file!');
}

if (options.sslKey) {
    options.sslKey = fs.readFileSync(path.resolve(cwd, options.sslKey), 'utf8');
    options.sslCrt = fs.readFileSync(path.resolve(cwd, options.sslCrt), 'utf8');
}

const useOpts = {};

if (options.mode === 'client') {
    Object.assign(useOpts, defaultClientOpts, options);
} else if (options.mode === 'server') {
    Object.assign(useOpts, defaultServerOpts, options);
} else {
    throw Error('unsupport mode:', options.mode);
}

console.log(useOpts);

module.exports = options;
