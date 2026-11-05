// Identity — ULID generation and origin-qualified ids. Pure (crypto only).
//
// An id is `g:<ulid>` (global root) or `p:<ulid>` (project root): the origin says which root holds the file.
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

/** ULID: 48-bit time + 80-bit randomness, Crockford base32, lexicographically sortable. */
export function ulid(now = Date.now()) {
  let t = Math.floor(now);
  let time = "";
  for (let i = 0; i < TIME_LEN; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(RAND_LEN);
  let rand = "";
  for (let i = 0; i < RAND_LEN; i++) rand += CROCKFORD.charAt((bytes[i] ?? 0) % 32);
  return time + rand;
}

/** Origin-qualified id, e.g. "p:01J…" (project) / "g:01J…" (global). */
export const qualify = (origin, id) => `${origin}:${id}`;
export const originOf = (id) => (id.startsWith("p:") ? "p" : "g");
export const bareId = (id) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);
export const newId = (origin) => qualify(origin, ulid());

/** A short, human-readable slug from text — for readable filenames (the ULID keeps identity). */
export const slug = (text) => {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 6).join("-").slice(0, 60);
  return words || "memory";
};
