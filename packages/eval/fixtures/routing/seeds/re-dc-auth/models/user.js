// User model: an in-memory store with the shape the rest of the app builds on. Today it stores a
// plaintext-free profile only — there is no credential field yet. An auth feature would extend this
// to hold a password hash alongside the profile.

const users = new Map();
let nextId = 1;

export function createUser({ email, name }) {
  const id = String(nextId++);
  const user = { id, email, name, createdAt: Date.now() };
  users.set(id, user);
  return user;
}

export function getUser(id) {
  return users.get(id);
}

export function findByEmail(email) {
  for (const user of users.values()) {
    if (user.email === email) return user;
  }
  return undefined;
}

export function allUsers() {
  return [...users.values()];
}
