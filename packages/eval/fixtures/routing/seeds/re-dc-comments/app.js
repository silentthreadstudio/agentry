// App wiring: mounts the routes and starts the background workers. A comments feature would wire its
// routes and its moderation worker in here, next to these.

import express from "express";
import { registerPostRoutes } from "./api/posts.routes.js";
import { startIndexWorker } from "./workers/index-rebuild.worker.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerPostRoutes(router);
  app.use("/api", router);

  startIndexWorker();

  return app;
}
