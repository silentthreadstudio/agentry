#!/usr/bin/env node
// mem — the memory store's CLI, `agentry mem <verb> [--json] …`: write, update, recall, search, feedback,
// forget, recover, stats, distill, consolidate, resync, episode. The verbs live in `lib/memory/cli/<verb>.mjs`;
// the routing (flags, help, exit codes) is `lib/cli/router.mjs`, shared with `board.mjs` and `lane.mjs`. The
// global store is `AGENTRY_GLOBAL_DIR`'s (else the home directory's); the project store is
// `CLAUDE_PROJECT_DIR`'s or `AGENTRY_PROJECT_DIR`'s, else the main checkout of the cwd's git repo
// (`lib/memory/resolution/roots.mjs`). Node built-ins only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./lib/cli/router.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
await main(process.argv.slice(2), {
  dir: join(HERE, "lib", "memory", "cli"),
  name: "mem",
});
