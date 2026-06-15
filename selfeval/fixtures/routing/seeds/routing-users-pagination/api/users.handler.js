// HTTP layer: parses the request and delegates to the service. No pagination — returns every user.

import { listUsers } from "../services/users.service.js";

export async function handleListUsers(req, res) {
  const users = await listUsers();
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(users));
}
