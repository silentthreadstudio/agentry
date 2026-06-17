// REST routes for orders. The checkout endpoint (POST a cart, get back a priced + reserved order)
// would register here the same way these routes do — calling the pricing service, then enqueuing an
// inventory-reservation job before responding.

import { placeOrder, findOrder, listOrders } from "../services/order.service.js";

export function registerOrderRoutes(router) {
  router.post("/orders", (req, res) => {
    const order = placeOrder(req.body);
    res.status(201).json(order);
  });

  router.get("/orders", (_req, res) => {
    res.status(200).json(listOrders());
  });

  router.get("/orders/:id", (req, res) => {
    const order = findOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "not found" });
    res.status(200).json(order);
  });
}
