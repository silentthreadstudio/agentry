// Runtime seam for `node:sqlite`: resolves `DatabaseSync` once at import — the class the
// index constructor instantiates — or `null` when the runtime lacks it (e.g. Bun 1.3.13). dynamic
// import + try/catch so importing this module never throws on a driver-less runtime.
let driver = null;
try {
  driver = (await import("node:sqlite")).DatabaseSync ?? null;
} catch {
  driver = null; // no node:sqlite here
}

/** The `DatabaseSync` class of this runtime, or `null` when it has no `node:sqlite`. Resolved once. */
export function openSqlite() {
  return driver;
}
