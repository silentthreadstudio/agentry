// lane — the lane group as two native tools over the shared seam (`src/run.mjs`): reads are typed
// verbs (the CLI stays the one validator their details run against), writes pass whole flags and
// arguments through as `words`, each one whole token. `agentry_lane` never writes: session is start
// (its own two records write, exactly as the CLI's start does), sweep is passed without `--apply` so
// the CLI reports its plan only, and show is `exec show <id>`. `agentry_lane_drive` never injects a
// flag either — sweep's `--apply` travels only when someone passes it in `words` — so every refusal
// stays the CLI's own (its exit 2 = the denial). Node built-ins only.
import { runVerb } from "../run.mjs";

const READ_VERBS = ["session", "sweep", "show"];
const DRIVE_VERBS = ["exec", "merge", "sweep", "note", "spike", "session"];

const ROOT_PARAM = {
  type: "string",
  description: "Absolute path of the repository to run against; defaults to the current directory.",
};

const WORDS_PARAM = {
  type: "array",
  items: { type: "string" },
  description:
    "Sub-args and flags for the CLI, each one whole flag or argument (never a shell line); the CLI validates them.",
};

export const laneRead = {
  name: "agentry_lane",
  description:
    "Read the agentry lane: session start (the conductor's one view), sweep (the cleanup plan, nothing applied), or exec show (a lane's ledger and pending step).",
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
        description: "For show: the lane task's id; unused by the other reads.",
      },
    },
  },
  async execute(input) {
    const { verb, json, root, id } = input ?? {};
    // `session` is start: the conductor's opening. close travels through the drive tool's words.
    if (verb === "session") return runVerb("lane", ["session", "start"], { root, json });
    // `sweep` is the plan only — the CLI reports exactly when `--apply` is absent, and no way to send
    // one travels with this tool.
    if (verb === "sweep") return runVerb("lane", ["sweep"], { root, json });
    // `show` ＝ `exec show <id>`; a missing id is the CLI's own exit-2 refusal.
    return runVerb("lane", ["exec", "show", ...(id ? [id] : [])], { root, json });
  },
};

export const laneDrive = {
  name: "agentry_lane_drive",
  description:
    "Drive the agentry lane: exec steps, merge, sweep --apply, note, spike, or session close (words: [close], always JSON) — steps, ids and flags travel as words; the CLI is the one strict validator and its exit 2 is the denial.",
  options: { namespace: "agentry" },
  input: {
    type: "object",
    additionalProperties: false,
    required: ["verb"],
    properties: {
      verb: { type: "string", enum: DRIVE_VERBS, description: "Which write to run." },
      words: WORDS_PARAM,
      root: ROOT_PARAM,
    },
  },
  async execute(input) {
    const { verb, words = [], root } = input ?? {};
    return runVerb("lane", [verb, ...words], { root });
  },
};
