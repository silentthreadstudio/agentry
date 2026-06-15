// Service layer: business logic over the data-access layer. Today it just passes the full list through.

import { fetchAllUsers } from "../data/users.dao.js";

export async function listUsers() {
  return fetchAllUsers();
}
