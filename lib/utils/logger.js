const log4js = require('log4js');

module.exports = function (label, level, logFile) {
    if (logFile) {
        log4js.loadAppender('file');
        log4js.addAppender(log4js.appenders.file(logFile), label);
    }
    const logger = log4js.getLogger(label);
    logger.level = level;
    return logger;
};
