import { MEMORY_TYPES, SCOPES } from "../domain/schema.mjs";
// mem write — capture a durable memory (the MCP's memory_write). Dedup-reinforces a near-duplicate of the
// same type instead of creating a copy; `--supersedes` retires the named fact and skips that dedup.
//
// run(argv) -> { exit, out }   exit 0 = written or reinforced, 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";

const fields = {
  type: { kind: "enum", options: MEMORY_TYPES, required: true, doc: "what kind of memory" },
  scope: {
    kind: "enum",
    options: SCOPES,
    required: true,
    doc: "repo goes to the project root when there is one",
  },
  text: { kind: "string", required: true, doc: "the memory itself" },
  why: { kind: "string", doc: "why it matters" },
  tags: { kind: "list", value: "<tag>", doc: "a tag" },
  subject: { kind: "string", doc: "evolution types only: the harness target" },
  repoId: { kind: "string", value: "<repo>", doc: "the repo it is about" },
  supersedes: { kind: "string", value: "<id>", doc: "the id of a fact this one replaces" },
  provenance: { kind: "list", value: "<id>", doc: "an episode or fact id it came from" },
};

export const noSpec = true;
export const help = {
  usage: usage("write", fields),
  purpose: "Capture a durable memory: a gotcha, decision, preference or repo-fact.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example:
    'agentry mem write --type gotcha --scope repo --text "esbuild must mark node:sqlite external"',
};

export const run = (argv) =>
  command("write", fields, argv, (service, args) => ok(service.write(args)));
