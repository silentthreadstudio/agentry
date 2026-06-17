'use strict';

// Realtime feature wiring. Today it only carries notifications. Chat
// (gateway + persistence + presence) gets composed in here once each
// unit exists, the same way notifications are wired below.
const { WsServer } = require('../gateways/ws-server');

function createRealtime({ wsServer = new WsServer() } = {}) {
  wsServer.on('notification.read', (socket, payload) => {
    wsServer.broadcast('notification.cleared', { id: payload.id });
  });

  return { wsServer };
}

module.exports = { createRealtime };
