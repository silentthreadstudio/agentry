#!/usr/bin/env node
// board — the process kit's CLI: `board.mjs [<sub>] [--root <git root>] [--process
// <file>] …`. The subcommands live in `lib/process/cli/<sub>.mjs`; the routing (flags, spec load, exit
// codes) is `lib/cli/router.mjs`, shared with `lane.mjs`. No sub = `status`. Node built-ins only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./lib/cli/router.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
await main(process.argv.slice(2), {
  dir: join(HERE, "lib", "process", "cli"),
  defaultSub: "status",
  name: "board",
});
