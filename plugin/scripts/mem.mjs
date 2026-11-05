#!/usr/bin/env node
// mem — the memory store's CLI: `mem <verb> [--json] …`, one verb per memory tool (write, update, recall,
// search, feedback, forget, recover, stats, distill, consolidate, resync, episode). The verbs live in
// `lib/memory/cli/<verb>.mjs`; the routing (flags, help, exit codes) is `lib/cli/router.mjs`, shared with
// `board.mjs` and `lane.mjs`. The store is the one the environment names (`AGENTRY_GLOBAL_DIR`,
// `CLAUDE_PROJECT_DIR` / `AGENTRY_PROJECT_DIR`). Node built-ins only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./lib/cli/router.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
await main(process.argv.slice(2), {
  dir: join(HERE, "lib", "memory", "cli"),
  name: "mem",
});
