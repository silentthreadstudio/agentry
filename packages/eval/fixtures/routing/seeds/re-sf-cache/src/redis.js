'use strict';

// Shared Redis client stub (Convention B).
const redis = {
  async get(key) {
    void key;
    return null;
  },
  async set(key, value, mode, ttl) {
    void key;
    void value;
    void mode;
    void ttl;
  },
  async del(key) {
    void key;
  },
};

module.exports = { redis };
