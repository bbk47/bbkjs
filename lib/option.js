const program = require('commander');
const path = require('path');
const { env } = require('process');
const pkgJson = require('../package.json');
const cwd = process.cwd();

const defaultOpts = {
    method: 'aes-256-cfb', // local/server
    password: 'p@ssword', // local/server
    listenAddr: '127.0.0.1', // local/server
    listenPort: 5900, // local/server
    logLevel: 'info', // local/server
    websocketUrl: '', // local
    websocketPath: '/websocket', // server
    fillByte: 0, // local/server
    ping: false,
};

program
    .version(pkgJson.version)
    .option('-c --config <json file>', 'config file, if exist, ignore command line args')
    .option('-m --method <method>', `encryption method, default: ${defaultOpts.method}`)
    .option('-k --password <password>', `password, default: ${defaultOpts.password}`)
    .option('-l --listen-addr <ip address>', `set binding ip address, default: ${defaultOpts.listenAddr}`)
    .option('-p --listen-port <port>', `set listen  port, default: ${defaultOpts.listenPort}`)
    .option('--websocket-url <ws url>', `connect server  ws url, required`)
    .option('--websocket-path <ws url>', `server websocket work path,  default: ${defaultOpts.websocketPath}`)
    .option('--ping <true|false>', `send heart pack check health for ws, default: ${defaultOpts.ping}`)
    .option('--log-level <level>', 'log level(debug|info|warn|error|fatal)', defaultOpts.logLevel)
    .option('--log-file <file>', 'log file')
    .option('--fill-byte', `fill random byte before transport data, default: ${defaultOpts.fillByte}`)
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
    if (env.METHOD) {
        options.method = env.METHOD;
    }
    if (env.PASSWORD) {
        options.password = env.PASSWORD;
    }
    if (env.LISTEN_ADDR) {
        options.listenAddr = env.LISTEN_ADDR;
    }
    if (env.WEBSOCKET_PATH) {
        options.websocketPath = env.WEBSOCKET_PATH;
    }
    if (env.PORT) {
        options.listenPort = env.PORT;
    }
    if (env.FILL_BYTE) {
        options.fillByte = Number(env.FILL_BYTE);
    }
}

const optdata = Object.assign({}, defaultOpts, options);
console.log(JSON.stringify(optdata, null, 2));
module.exports = optdata;
