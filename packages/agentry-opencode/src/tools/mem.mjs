// mem — the memory group as two native tools over the shared seam (`src/run.mjs`): reads are typed —
// `query` and `limit` — because recall and search are the hot path and the CLI's own parser still
// validates every value; writes pass whole flags and arguments through as `words`, each one whole
// token, so the CLI's grammar (write's fields, update's, feedback's) never forks. `agentry_mem` never
// writes; `agentry_mem_write` refuses nothing itself — the CLI's exit 1 and exit 2 travel through the
// seam as content and denials. Node built-ins only.
import { runVerb } from "../run.mjs";

const READ_VERBS = ["recall", "search", "stats"];
const WRITE_VERBS = ["write", "update", "forget", "feedback", "episode"];

const ROOT_PARAM = {
  type: "string",
  description:
    "Absolute path of the repository to run against; defaults to the current directory. The memory store itself resolves from the environment, then the current git root, then the global location — this parameter does not relocate it.",
};

const WORDS_PARAM = {
  type: "array",
  items: { type: "string" },
  description:
    "The CLI's own grammar for the verb: each member one whole flag or argument (never a shell line), e.g. write --type <t> --scope <s> --text <t>.",
};

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
  async execute(input) {
    const { verb, query, limit, json, root } = input ?? {};
    if (verb === "stats") return runVerb("mem", ["stats"], { root, json });
    const words = [verb];
    if (query !== undefined) words.push("--query", query);
    if (limit !== undefined) words.push("--limit", String(limit));
    return runVerb("mem", words, { root, json });
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
  async execute(input) {
    const { verb, words = [], root } = input ?? {};
    return runVerb("mem", [verb, ...words], { root });
  },
};
