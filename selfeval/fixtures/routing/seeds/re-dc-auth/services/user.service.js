// User service: business logic over the user model. Today it only creates and reads profiles. Auth
// would add registerWithCredentials / verifyCredentials here, leaning on a password-hashing service
// and persisting the resulting hash through the model.

import { createUser, getUser, findByEmail, allUsers } from "../models/user.js";

export function createProfile(input) {
  return createUser(input);
}

export function findProfile(id) {
  return getUser(id);
}

export function findProfileByEmail(email) {
  return findByEmail(email);
}

export function listProfiles() {
  return allUsers();
}
