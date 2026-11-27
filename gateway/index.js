'use strict';

/**
 * Slim gateway entrypoint.
 * Starts the HTTP/WS gateway when executed directly and exports app/server/createApp for tests.
 */

const bootstrap = require('./src/bootstrap');

let instance = null;

function start(deps) {
  instance = bootstrap.start(deps);
  return instance;
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  createApp: bootstrap.createApp,
  get app() {
    return instance ? instance.app : null;
  },
  get server() {
    return instance ? instance.server : null;
  }
};
