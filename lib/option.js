const program = require('commander');
const fs = require('fs');
const path = require('path');
const { env } = require('process');
const pkgJson = require('../package.json');
const cwd = process.cwd();

const defaultOpts = {
    protocol: 'ws',
    mode: 'server',
    method: 'aes-256-cfb', // local/server
    password: 'p@ssword', // local/server
    listenAddr: '127.0.0.1', // local/server
    listenPort: 5900, // local/server
    logLevel: 'info', // local/server
    tunnelOpts:{},
    rnglen: 0, // local/server
    ping: false,
};

program
    .version(pkgJson.version)
    .option('-c --config <json file>', 'config file, if exist, ignore command line args')
    .option('--protocol <transport protocol>', `data transport protocol (ws|http2), default:${defaultOpts.protocol}`)
    .option('--mode <app mode>', `application run mode (client|server), required`)
    .option('-m --method <method>', `encryption method, default: ${defaultOpts.method}`)
    .option('-k --password <password>', `password, default: ${defaultOpts.password}`)
    .option('-l --listen-addr <ip address>', `set binding ip address, default: ${defaultOpts.listenAddr}`)
    .option('-p --listen-port <port>', `set listen  port, default: ${defaultOpts.listenPort}`)
    .option('--websocket-url <ws url>', `connect server  ws url, required`)
    .option('--websocket-path <ws url>', `server websocket work path,  default: ${defaultOpts.websocketPath}`)
    .option('--ping <true|false>', `send heart pack check health for ws, default: ${defaultOpts.ping}`)
    .option('--log-level <level>', 'log level(debug|info|warn|error|fatal)', defaultOpts.logLevel)
    .option('--log-file <file>', 'log file')
    .option('--ssl-key <ssl key pem>', 'tls key file')
    .option('--ssl-crt <ssl cert pem>', 'tls cert file')
    .option('--rnglen', `random byte append to data, default: ${defaultOpts.rnglen}`)
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
console.log(JSON.stringify(optdata, null, 2));

if (optdata.sslKey) {
    optdata.sslKey = fs.readFileSync(path.resolve(cwd, optdata.sslKey), 'utf8');
    optdata.sslCrt = fs.readFileSync(path.resolve(cwd, optdata.sslCrt), 'utf8');
}

module.exports = optdata;
