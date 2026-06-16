// REST routes for resources. The mutating routes below (POST/PATCH/DELETE) are where logging
// middleware would attach. An audit query endpoint (read the log) would register here the same way.

import {
  addResource,
  editResource,
  removeResource,
  findResource,
  listResources,
} from "../services/resource.service.js";

export function registerResourceRoutes(router) {
  router.post("/resources", (req, res) => {
    const resource = addResource(req.body);
    res.status(201).json(resource);
  });

  router.patch("/resources/:id", (req, res) => {
    const resource = editResource(req.params.id, req.body);
    if (!resource) return res.status(404).json({ error: "not found" });
    res.status(200).json(resource);
  });

  router.delete("/resources/:id", (req, res) => {
    const ok = removeResource(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  router.get("/resources", (_req, res) => {
    res.status(200).json(listResources());
  });

  router.get("/resources/:id", (req, res) => {
    const resource = findResource(req.params.id);
    if (!resource) return res.status(404).json({ error: "not found" });
    res.status(200).json(resource);
  });
}
