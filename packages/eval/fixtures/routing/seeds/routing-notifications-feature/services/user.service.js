// User service: business logic over the user model and the email worker. A notifications service would
// mirror this — wrapping a notifications model and enqueuing delivery work.

import { createUser, getUser, allUsers } from "../models/user.js";
import { enqueueEmail } from "../workers/email.worker.js";

export function registerUser(input) {
  const user = createUser(input);
  enqueueEmail({ to: user.email, template: "welcome", userId: user.id });
  return user;
}

export function findUser(id) {
  return getUser(id);
}

export function listUsers() {
  return allUsers();
}
