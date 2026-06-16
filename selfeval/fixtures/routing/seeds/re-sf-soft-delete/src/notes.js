'use strict';

// In-memory notes store. This is the target for soft-delete: today remove()
// hard-deletes the row, so a deleted note can never be recovered.
//
// Note the existing timestamp convention below: createdAt / updatedAt are stored
// as ISO strings (new Date().toISOString()), NOT as epoch numbers and NOT as Date
// objects — every reader in queries.js assumes strings. A soft-delete marker has to
// pick a representation that fits this: a `deletedAt` ISO string? a boolean
// `deleted` flag? a nullable column? Whatever it is, every read path in queries.js
// has to learn to exclude it, and a recover path has to clear it.
const rows = new Map();
let seq = 0;

function create(text) {
  const id = ++seq;
  const now = new Date().toISOString();
  const note = { id, text, createdAt: now, updatedAt: now };
  rows.set(id, note);
  return note;
}

function get(id) {
  return rows.get(id) || null;
}

function update(id, text) {
  const note = rows.get(id);
  if (!note) return null;
  note.text = text;
  note.updatedAt = new Date().toISOString();
  return note;
}

// Hard delete — the row is gone, unrecoverable. This is what the task changes.
function remove(id) {
  return rows.delete(id);
}

function all() {
  return [...rows.values()];
}

module.exports = { create, get, update, remove, all, _rows: rows };
