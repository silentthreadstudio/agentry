'use strict';

// Read paths over the notes store. EVERY one of these currently assumes a row in
// the store is a live note — none of them filter out anything. If soft-delete lands
// as a tombstone left in the same Map, each of these silently starts leaking deleted
// notes unless it's updated to skip them. These are the readers that fix the meaning
// of "deleted": miss one and a recovered-deletable note shows up in a list or a count.
const notes = require('./notes');

function list() {
  return notes.all();
}

function search(term) {
  const t = String(term).toLowerCase();
  return notes.all().filter((n) => n.text.toLowerCase().includes(t));
}

function count() {
  return notes.all().length;
}

function byId(id) {
  return notes.get(id);
}

module.exports = { list, search, count, byId };
