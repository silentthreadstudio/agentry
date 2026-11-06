// id — the one rule for a lane task id. The id becomes a branch name (`agentry/<id>`), a worktree directory and
// a ledger file name, so the worktree and the ledger share this check: plain ASCII, nothing git refuses in a
// ref (`..`, `.lock`, a trailing `.`, a leading `-`) and nothing that could climb out of a directory.
// Node built-ins only.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX = 100;

/** Why `id` is not a usable task id, or null when it is. */
export function idProblem(id) {
  if (typeof id !== "string" || !ID.test(id)) return `id "${id}" must match ${ID}`;
  if (id.length > MAX) return `id "${id.slice(0, 20)}…" is longer than ${MAX} characters`;
  if (id.includes("..")) return `id "${id}" must not contain ".."`;
  if (id.includes(".lock")) return `id "${id}" must not contain ".lock"`;
  if (id.endsWith(".")) return `id "${id}" must not end with "."`;
  return null;
}
