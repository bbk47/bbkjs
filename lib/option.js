const program = require('commander');
const fs = require('fs');
const path = require('path');
const { env } = require('process');
const pkgJson = require('../package.json');
const cwd = process.cwd();

const defaultOpts = {
    mode: 'server',
    method: 'aes-256-cfb', // local/server
    password: 'p@ssword', // local/server
    listenAddr: '127.0.0.1', // local/server
    listenPort: 5900, // local/server
    logLevel: 'info', // local/server
    workMode: 'ws',
    workPath: '/wss',
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

program
    .version(pkgJson.version)
    .option('-c --config <json file>', 'config file, if exist, ignore command line args')

    .option('--mode <app mode>', `application run mode (client|server), required`)
    .option('-l --listen-addr <ip address>', `set binding ip address, default: ${defaultOpts.listenAddr}`)
    .option('-p --listen-port <port>', `set listen  port, default: ${defaultOpts.listenPort}`)
    .option('--log-level <level>', 'log level(debug|info|warn|error|fatal)', defaultOpts.logLevel)
    .option('-m --method <method>', `encryption method, default: ${defaultOpts.method}`)
    .option('-k --password <password>', `password, default: ${defaultOpts.password}`)
    .option('-p --listen-http-port <port>', `set http connect listen  port`)
    .option('--work-mode <ws|tcp|tls|h2>', `server work mode  default: ${defaultOpts.workMode}`)
    .option('--work-path <ws|http2 url>', `server websocket work path,  default: ${defaultOpts.workPath}`)
    .option('--ping <true|false>', `send heart pack check health for ws, default: ${defaultOpts.ping}`)
    .option('--tunnel-protocol <ws|tcp|tls|h2>', `tunnel work protocol, required`)
    .option('--tunnel-host <ip|domain>', `tunnel work hostname, required`)
    .option('--tunnel-port <port>', `tunnel work port, required`)
    .option('--tunnel-secure <boolean>', `tunnel work is secure, for ws or h2`)
    .option('--tunnel-path <pathname>', `tunnel work path, for ws or h2`)
    .option('--tunnel-method <string>', `tunnel encrypt method, required`)
    .option('--tunnel-password <string>', `tunnel encrypt password, required`)
    .option('--ssl-key <ssl key pem>', 'tls key file')
    .option('--ssl-crt <ssl cert pem>', 'tls cert file')
    .parse(process.argv);

let options = program.opts();

if (options.config) {
    const configfile = path.resolve(cwd, options.config);
    try {
        options = require(configfile);
    } catch (err) {
        console.log(`load config file ${configfile} failed.`);
    }
} else {
    if (env.MODE) {
        options.mode = env.MODE;
    }
}

const optdata = Object.assign({}, defaultOpts, options);
if (optdata.mode === 'server') {
    delete optdata.tunnelOpts;
}
console.log(JSON.stringify(optdata, null, 2));

if (optdata.sslKey) {
    optdata.sslKey = fs.readFileSync(path.resolve(cwd, optdata.sslKey), 'utf8');
    optdata.sslCrt = fs.readFileSync(path.resolve(cwd, optdata.sslCrt), 'utf8');
}

module.exports = optdata;
