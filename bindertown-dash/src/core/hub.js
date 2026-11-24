// One shared object for what the main process and its feature modules use across files.
module.exports = {};

// one way to wait, for every feature
module.exports.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
