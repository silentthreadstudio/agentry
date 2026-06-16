// REST routes for documents. There is no upload endpoint yet — an upload route (multipart in,
// metadata out) would register here the same way these JSON routes do, but it needs a storage
// adapter and the upload model behind it that don't exist yet.

import { addDocument, findDocument, listDocuments } from "../services/document.service.js";

export function registerDocumentRoutes(router) {
  router.post("/documents", (req, res) => {
    const doc = addDocument(req.body);
    res.status(201).json(doc);
  });

  router.get("/documents", (_req, res) => {
    res.status(200).json(listDocuments());
  });

  router.get("/documents/:id", (req, res) => {
    const doc = findDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "not found" });
    res.status(200).json(doc);
  });
}
