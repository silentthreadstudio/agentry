// run — the one in-process seam between the plugin's tools and the vendored CLI core:
// `runVerb(group, words, { root, json })` routes through `route()` in the vendored router. The
// entry scripts are never imported (each runs its CLI at import time); the router is the seam
// because it returns `{ exit, out }` and touches no process state. Map: exit 0 and 1 → the CLI's
// own text as the tool's content (findings are content); exit 2 → a thrown Error carrying the
// CLI's printed refusal verbatim, which the host renders as a tool error; any other throw gets the
// `✗ agentry_<group>: …` shape. Node built-ins only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every group's cli dir under the package's vendored copy, and its default sub exactly as the
// group's entry script passes it (the board group runs `status` with no sub; lane and mem name none).
const FACES = {
  board: { dir: "../vendor/scripts/lib/process/cli/", defaultSub: "status" },
  lane: { dir: "../vendor/scripts/lib/lane/cli/" },
  mem: { dir: "../vendor/scripts/lib/memory/cli/" },
};

const errorFor = (group, cause) => new Error(`✗ agentry_${group}: ${cause.message}`, { cause });

export async function runVerb(group, words, { root, json } = {}) {
  const face = FACES[group];
  if (!face) throw new Error(`✗ agentry_${group}: unknown group "${group}"`);
  // argv opens with the sub, not the group: route() reads argv[0] as the subcommand, so the
  // group's own name would read as `unknown subcommand "board"`.
  const argv = [...words];
  if (root) argv.push("--root", root);
  if (json) argv.push("--json");
  let routed;
  try {
    const router = await import(new URL("../vendor/scripts/lib/cli/router.mjs", import.meta.url));
    routed = await router.route(argv, {
      dir: join(dirname(fileURLToPath(import.meta.url)), face.dir),
      defaultSub: face.defaultSub,
      name: group,
    });
  } catch (cause) {
    throw errorFor(group, cause);
  }
  if (routed.exit === 2) throw new Error(routed.out);
  return { content: [{ type: "text", text: routed.out }] };
}
