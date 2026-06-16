'use strict';

// The app already runs a websocket layer. This is a tiny transport-only
// wrapper: it tracks raw sockets and dispatches inbound frames to a
// registered handler. The chat gateway plugs a handler in here; it does
// NOT own message persistence or presence.
class WsServer {
  constructor() {
    this._sockets = new Set();
    this._handlers = new Map();
  }

  on(type, handler) {
    this._handlers.set(type, handler);
  }

  accept(socket) {
    this._sockets.add(socket);
    socket.onClose(() => this._sockets.delete(socket));
    socket.onFrame((frame) => {
      const handler = this._handlers.get(frame.type);
      if (handler) handler(socket, frame.payload);
    });
  }

  broadcast(type, payload) {
    const frame = { type, payload };
    for (const socket of this._sockets) socket.send(frame);
  }
}

module.exports = { WsServer };
