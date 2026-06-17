'use strict';

// Composition root. Each subsystem is a separable unit wired together
// here: domain models, persistence services, transport gateways, and the
// realtime feature layer.
const { createUser } = require('./models/user');
const { UserStore } = require('./services/user-store');
const { createRealtime } = require('./realtime');

function createApp() {
  const users = new UserStore();
  const realtime = createRealtime();
  return { users, realtime, createUser };
}

module.exports = { createApp };
