// board — the board group as two native tools over the shared seam (`src/run.mjs`): reads are typed
// verbs (the CLI stays the one validator their details run against), writes pass whole flags and
// arguments through as `words` with an optional typed `fields` object serialized to `--fields`.
// `agentry_board` never writes; `agentry_board_write` previews by default — the CLI previews every
// write whose `--apply` is absent, and nothing here injects one. Node built-ins only.
import { runVerb } from "../run.mjs";

const READ_VERBS = [
  "status",
  "check",
  "explain",
  "contract",
  "next-id",
  "commits",
  "scan",
  "draft",
  "instructions",
];
const WRITE_VERBS = ["add", "set", "fix", "draft"];

const ROOT_PARAM = {
  type: "string",
  description: "Absolute path of the repository to run against; defaults to the current directory.",
};

export const boardRead = {
  name: "agentry_board",
  description:
    "Read the agentry board: status, check, explain, contract (id of an item), next-id (id is a kind), commits, scan, draft list, or instructions (what would change in the trigger block).",
  options: { namespace: "agentry" },
  input: {
    type: "object",
    additionalProperties: false,
    required: ["verb"],
    properties: {
      verb: { type: "string", enum: READ_VERBS, description: "Which read to run." },
      json: { type: "boolean", description: "Print the CLI's --json object instead of its text." },
      root: ROOT_PARAM,
      id: {
        type: "string",
        description: "For contract an item's id, for next-id a kind; unused by the other reads.",
      },
    },
  },
  async execute(input) {
    const { verb, json, root, id } = input ?? {};
    if (verb === "draft") return runVerb("board", ["draft", "list"], { root, json });
    // `commits` has one mode: the CLI refuses its invocation without `--learn`.
    const words = verb === "commits" ? [verb, "--learn"] : [verb];
    if ((verb === "contract" || verb === "next-id") && id) words.push(id);
    return runVerb("board", words, { root, json });
  },
};

export const boardWrite = {
  name: "agentry_board_write",
  description:
    "Change the agentry board: add, set, fix, or draft add/drop/apply — each previews by default and writes only with --apply passed in words.",
  options: { namespace: "agentry" },
  input: {
    type: "object",
    additionalProperties: false,
    required: ["verb"],
    properties: {
      verb: { type: "string", enum: WRITE_VERBS, description: "Which write to run." },
      words: {
        type: "array",
        items: { type: "string" },
        description:
          "Sub-args and flags for the CLI, each one whole flag or argument (never a shell line); carries --apply where a write is wanted.",
      },
      fields: {
        type: "object",
        description: "For add and draft add: the item's or draft's fields as one JSON object.",
      },
      root: ROOT_PARAM,
    },
  },
  async execute(input) {
    const { verb, words = [], fields, root } = input ?? {};
    const call = [verb, ...words];
    if (fields !== undefined) call.push("--fields", JSON.stringify(fields));
    return runVerb("board", call, { root });
  },
};
