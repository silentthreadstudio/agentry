// User model: an in-memory store with the shape every other module builds on. A notifications model
// would sit alongside this one.

const users = new Map();

export function createUser({ id, email, name }) {
  const user = { id, email, name, createdAt: Date.now() };
  users.set(id, user);
  return user;
}

export function getUser(id) {
  return users.get(id);
}

export function allUsers() {
  return [...users.values()];
}
