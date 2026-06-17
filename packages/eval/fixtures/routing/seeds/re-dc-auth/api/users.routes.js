// REST routes for users. Today these are unauthenticated profile routes. Auth endpoints
// (POST /auth/signup, POST /auth/login) would register the same way, in their own routes module, and
// protected routes would gain a session middleware in front of them.

import { createProfile, findProfile, listProfiles } from "../services/user.service.js";
import { requireFields } from "../middleware/require-fields.js";

export function registerUserRoutes(router) {
  router.post("/users", requireFields("email", "name"), (req, res) => {
    const user = createProfile(req.body);
    res.status(201).json(user);
  });

  router.get("/users", (_req, res) => {
    res.status(200).json(listProfiles());
  });

  router.get("/users/:id", (req, res) => {
    const user = findProfile(req.params.id);
    if (!user) return res.status(404).json({ error: "not found" });
    res.status(200).json(user);
  });
}
