const Transport = require('./transport');
const creater = require('./creater');
const helper = require('./helper');

exports.Transport = Transport;
exports.creater = creater;
exports.helper = helper;

exports.wrapSocket = function (type, conn) {
    return new Transport({ type, conn });
};
