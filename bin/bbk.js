#!/usr/bin/env node

const options = require('../lib/option');
const BBK = require('../');

let app;

if (options.mode === 'client') {
    app = new BBK.Client(options);
} else if (options.mode === 'server') {
    app = new BBK.Server(options);
} else {
    console.log(`unsupport mode[${options.mode}!must be in (client,server)`);
}

app.bootstrap();
