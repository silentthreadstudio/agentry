'use strict';

// Domain model. Plain factory + validation, no I/O.
function createUser({ id, displayName }) {
  if (!id) throw new Error('user.id is required');
  if (!displayName) throw new Error('user.displayName is required');
  return { id: String(id), displayName: String(displayName) };
}

module.exports = { createUser };
