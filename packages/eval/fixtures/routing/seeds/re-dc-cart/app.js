// App wiring: mounts the routes and starts the background workers. The shopping-cart feature would
// wire its checkout route and its inventory-reservation worker in here, next to these — a cart model
// and pricing service sit behind them, mirroring how the order pieces below are layered.

import express from "express";
import { registerOrderRoutes } from "./api/orders.routes.js";
import { startFulfillmentWorker } from "./workers/fulfillment.worker.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerOrderRoutes(router);
  app.use("/api", router);

  startFulfillmentWorker();

  return app;
}
