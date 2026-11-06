#!/usr/bin/env node
// init — the OpenCode adapter's group CLI (`agentry init --host opencode …`): the verb itself is
// `lib/cli/init.mjs`, which runs the generator and the board verbs it wires through, so the payload,
// the vendored copy and the trigger block come from their own writers. Node built-ins only.
import { main } from "./lib/cli/init.mjs";

process.exitCode = await main(process.argv.slice(2));
