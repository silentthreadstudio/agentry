// App wiring: mounts the routes and starts the background workers. A file-upload feature would wire
// its upload endpoint here and start a thumbnail worker next to the existing audit worker.

import express from "express";
import { registerDocumentRoutes } from "./api/documents.routes.js";
import { startAuditWorker } from "./workers/audit.worker.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerDocumentRoutes(router);
  app.use("/api", router);

  startAuditWorker();

  return app;
}
