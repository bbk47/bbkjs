const protocol = require('./protocol');

const Encryptor = require('@bbk47/toolbox').encrypt.Encryptor;

module.exports = function serizlizerFactory(password, method, rnglen) {
    const encryptWorker = new Encryptor(password, method);

    return {
        serialize: function (frame) {
            const dataBytes = protocol.encode(frame, rnglen);
            // encrypt
            return encryptWorker.encrypt(dataBytes);
        },
        derialize: function (binarydata) {
            binarydata = encryptWorker.decrypt(binarydata);
            return protocol.decode(binarydata);
        },
    };
};
