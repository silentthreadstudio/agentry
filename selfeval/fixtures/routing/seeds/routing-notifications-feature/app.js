// App wiring: mounts the routes and starts the background workers. A notifications feature would wire
// its routes and delivery worker in here, next to these.

import express from "express";
import { registerUserRoutes } from "./api/users.routes.js";
import { startEmailWorker } from "./workers/email.worker.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerUserRoutes(router);
  app.use("/api", router);

  startEmailWorker();

  return app;
}
