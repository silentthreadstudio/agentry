#!/usr/bin/env node
// lane — the lane steppers' CLI: `lane.mjs <sub> [--root <git root>] [--process <file>] …`. The
// subcommands live in `lib/lane/cli/<sub>.mjs`; the router is shared with `board.mjs`, so a broken
// process file stops a lane step exactly as it stops `board check`. Node built-ins only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./lib/cli/router.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
await main(process.argv.slice(2), { dir: join(HERE, "lib", "lane", "cli"), name: "lane" });
