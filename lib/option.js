const program = require('commander');
const path = require('path');
const pkgJson = require('../package.json');
const cwd = process.cwd();

const defaultOpts = {
    method: 'aes-256-cfb',
    password: 'p@ssword',
    serverAddress: '',
    serverPort: '8388',
    localAddress: '127.0.0.1',
    localPort: '1080',
    websocketUri: '/websocket',
    tls: false,
    mix: false,
    logLevel: 'info',
};

program
    .version(pkgJson.version)
    .option('-c --config <json file>', 'config file, if exist, ignore command line args')
    .option('-m --method <method>', `encryption method, default: ${defaultOpts.method}`)
    .option('-k --password <password>', `password, default: ${defaultOpts.password}`)
    .option('-s --server-address <address>', 'server address')
    .option('-p --server-port <port>', `server port, default: ${defaultOpts.serverPort}`)
    .option('-u --websocket-uri <websocketUri>', `websocket uri, default: ${defaultOpts.websocketUri}`)
    .option('-b --local-address <address>', `local binding address, default: ${defaultOpts.localAddress}`)
    .option('-l --local-port <port>', `local port, default: ${defaultOpts.localPort}`)
    .option('--tls <true|false>', `http tls, default: ${defaultOpts.tls}`)
    .option('--log-level <level>', 'log level(debug|info|warn|error|fatal)', defaultOpts.logLevel)
    .option('--log-file <file>', 'log file')
    .parse(process.argv);

let options = program.opts();

if (options.config) {
    const configfile = path.resolve(cwd, options.config);
    try {
        options = require(configfile);
    } catch (err) {
        console.log(`load config file ${configfile} failed.`);
    }
}

module.exports = Object.assign({}, defaultOpts, options);
