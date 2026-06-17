// REST routes for users. A notifications endpoint (list + mark-as-read) would register here the same
// way these routes do.

import { registerUser, findUser, listUsers } from "../services/user.service.js";

export function registerUserRoutes(router) {
  router.post("/users", (req, res) => {
    const user = registerUser(req.body);
    res.status(201).json(user);
  });

  router.get("/users", (_req, res) => {
    res.status(200).json(listUsers());
  });

  router.get("/users/:id", (req, res) => {
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "not found" });
    res.status(200).json(user);
  });
}
