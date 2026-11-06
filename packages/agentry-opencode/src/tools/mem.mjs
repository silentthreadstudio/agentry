// mem — the memory group as two native tools. Unlike board and lane (which run through the shared
// in-process seam), these run the vendored CLI as a child process: the store resolution reads the
// process environment, and the one experience this runtime gave the in-process route is that env
// writes from our own side do not reach the CLI chain (measured four separate ways on this branch).
// A spawned child gets the store's root as the CLI's own first-resolution env variable, so every
// read and write lands in this session's repo store, never the service process's. Node built-ins
// only.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MEM = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "vendor",
  "scripts",
  "mem.mjs",
);

const READ_VERBS = ["recall", "search", "stats"];
const WRITE_VERBS = ["write", "update", "forget", "feedback", "episode"];

const ROOT_PARAM = {
  type: "string",
  description:
    "Absolute path of the repository to run against; defaults to the location that loaded this plugin. For the memory group this root is also the store root: the CLI resolves this session's store under it, so a session works on its own repo's store and never the service process's.",
};

const WORDS_PARAM = {
  type: "array",
  items: { type: "string" },
  description:
    "The CLI's own grammar for the verb: each member one whole flag or argument (never a shell line), e.g. write --type <t> --scope <s> --text <t>.",
};

// The spawned CLI's env: the store root as the CLI's own first-resolution variable (both spellings
// the resolvers read), everything else inherited. cwd stays the caller's — with both variables set
// the cwd names no store.
function memEnv(root) {
  return { ...process.env, CLAUDE_PROJECT_DIR: root, AGENTRY_PROJECT_DIR: root };
}

/** Run the vendored `mem` CLI on `argv` with the store env above; map the exits like the seam does:
 *  0 → the CLI's stdout alone (its stderr carries runtime notices only), 1 → findings as content
 *  (stdout; stderr fills in when stdout is empty), 2 → throw its refusal verbatim (the host renders
 *  a tool error), anything else → the same shape carrying the cause. */
function memRun(argv, root, context) {
  const spawned = spawnSync(process.execPath, [MEM, ...argv], {
    encoding: "utf8",
    env: memEnv(root),
    signal: context?.signal,
  });
  if (spawned.error)
    throw new Error(`✗ agentry_mem: ${spawned.error.message}`, { cause: spawned.error });
  const stdout = (spawned.stdout ?? "").trim();
  const stderr = (spawned.stderr ?? "").trim();
  if (spawned.status === 0) return { content: [{ type: "text", text: stdout }] };
  if (spawned.status === 1)
    return { content: [{ type: "text", text: stdout || stderr || "(no output)" }] };
  throw new Error(stderr || stdout);
}

export const memRead = {
  name: "agentry_mem",
  description:
    "Read the agentry memory store: recall (the few, ranked, for a task), search (full-text with snippets), or stats.",
  options: { namespace: "agentry" },
  input: {
    type: "object",
    additionalProperties: false,
    required: ["verb"],
    properties: {
      verb: { type: "string", enum: READ_VERBS, description: "Which read to run." },
      query: {
        type: "string",
        description: "For recall and search: what the task is about; search requires one.",
      },
      limit: {
        type: "number",
        description: "At most this many results (recall defaults to 5, search to 10).",
      },
      json: { type: "boolean", description: "Print the CLI's --json object instead of its text." },
      root: ROOT_PARAM,
    },
  },
  async execute(input, context) {
    const { verb, query, limit, json, root } = input ?? {};
    const argv = [verb];
    if (query !== undefined) argv.push("--query", query);
    if (limit !== undefined) argv.push("--limit", String(limit));
    if (json) argv.push("--json");
    return memRun(argv, root, context);
  },
};

export const memWrite = {
  name: "agentry_mem_write",
  description:
    "Change the agentry memory store: write, update, forget, feedback, or episode — the store's own grammar in words; the CLI stays the validator.",
  options: { namespace: "agentry" },
  input: {
    type: "object",
    additionalProperties: false,
    required: ["verb"],
    properties: {
      verb: { type: "string", enum: WRITE_VERBS, description: "Which write to run." },
      words: WORDS_PARAM,
      root: ROOT_PARAM,
    },
  },
  async execute(input, context) {
    const { verb, words = [], root } = input ?? {};
    return memRun([verb, ...words], root, context);
  },
};
