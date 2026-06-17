// Document metadata model: an in-memory store keyed by id. This is the record shape every other
// module reads. A file-upload feature needs a sibling model holding upload metadata
// (filename, contentType, size, storageKey, thumbnailKey, status) — distinct from this one.

const documents = new Map();

export function createDocument({ id, title, ownerId }) {
  const doc = { id, title, ownerId, createdAt: Date.now() };
  documents.set(id, doc);
  return doc;
}

export function getDocument(id) {
  return documents.get(id);
}

export function allDocuments() {
  return [...documents.values()];
}
