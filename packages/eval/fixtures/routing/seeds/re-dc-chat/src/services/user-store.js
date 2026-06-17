'use strict';

// Persistence service for an existing domain (users). The chat
// message store should mirror this shape: an in-memory map keyed by id,
// async methods, returning plain records.
class UserStore {
  constructor() {
    this._byId = new Map();
  }

  async save(user) {
    this._byId.set(user.id, user);
    return user;
  }

  async get(id) {
    return this._byId.get(id) || null;
  }

  async list() {
    return [...this._byId.values()];
  }
}

module.exports = { UserStore };
