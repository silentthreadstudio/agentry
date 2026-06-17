// App wiring: mounts the routes and starts the background workers. The audit-log feature wires its
// logging middleware, its query routes, and its retention worker in here, alongside what's already here.

import express from "express";
import { registerResourceRoutes } from "./api/resources.routes.js";
import { startCleanupWorker } from "./workers/cleanup.worker.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerResourceRoutes(router);
  app.use("/api", router);

  startCleanupWorker();

  return app;
}
