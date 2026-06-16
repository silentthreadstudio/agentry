// Document service: business logic over the document model and the audit worker. An upload service
// would mirror this — persisting bytes through a storage adapter, recording upload metadata, and
// enqueuing a thumbnail job — but it is its own unit with its own contract.

import { createDocument, getDocument, allDocuments } from "../models/document.js";
import { enqueueAudit } from "../workers/audit.worker.js";

export function addDocument(input) {
  const doc = createDocument(input);
  enqueueAudit({ kind: "document.created", id: doc.id });
  return doc;
}

export function findDocument(id) {
  return getDocument(id);
}

export function listDocuments() {
  return allDocuments();
}
