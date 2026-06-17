// App wiring: mounts the routers under /api. There is no authentication anywhere in the app today.
// An auth feature would mount its own routes here (signup/login), install session middleware in front
// of the protected routers, and initialize a token store — next to this existing wiring.

import express from "express";
import { registerUserRoutes } from "./api/users.routes.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerUserRoutes(router);
  app.use("/api", router);

  return app;
}
