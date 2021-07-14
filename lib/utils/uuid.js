const uuid = require('uuid').v4;

function getRamdomUUID() {
    const id = uuid();
    return id.replace(/-/g, '');
}

// console.log(getRamdomUUID());

module.exports = getRamdomUUID;
