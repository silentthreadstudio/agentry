// board draft add --fields '{…}' | list | drop <n> | apply <n> — the owner's calls the conductor caught in
// conversation, held until the owner says OK. `add` keeps a draft in `.agentry/run`, `list` shows
// the pending ones, `drop` forgets one, and `apply` writes it: a decision through `next-id` and `add` with the
// workflow file's `drafts.decision.map` (`{answer}`, `{why}`, `{question}`, `{unpicked}`; with none in the file,
// a map derived from the decision kind), a rule as a line under `conductor.rules` in the conductor prompt.
// `apply <n> --answer "…"` (and `--why "…"`) writes the owner's edit of the draft and keeps it on the draft's line. Only `apply` writes to the repo, and the conductor runs it only
// after the owner's OK. The drafts live in the main checkout, so `apply` edits the main checkout's board: from
// inside a linked worktree it refuses rather than write the edit in one checkout and the state in another. A
// line of the drafts file that is not a draft is kept as written and named in the output of list, drop and
// apply. `apply <n>` alone shows what it would write and writes nothing; `apply <n> --apply` writes it.
// `add` and `drop` write only the drafts file under `.agentry/run`, never the repo: holding a draft
// is their job, and the drafts are the preview.
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = done or previewed, 2 = usage or refusal
// (nothing written)
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW, refuse, usageError } from "../../cli/help.mjs";
import * as drafts from "../drafts.mjs";
import { mainRoot, topLevel } from "../git.mjs";
import { fit } from "../render.mjs";
import { has, own } from "../spec/shape.mjs";
import { WriteError, appendLine, apply } from "../write.mjs";
import { run as addItem } from "./add.mjs";
import { run as nextId } from "./next-id.mjs";

export const help = {
  usage: [
    "draft add --fields '{…}' [--json]",
    "draft list [--json]",
    "draft drop <n> [--json]",
    'draft apply <n> [--answer "…"] [--why "…"] [--apply] [--json]',
  ],
  purpose: "The owner's calls caught in conversation, held until the owner says OK.",
  args: {
    "add|list|drop|apply": "keep a draft, show the pending ones, forget one, write one",
    "<n>": "a pending draft's number (see draft list)",
  },
  flags: {
    "--fields <json>":
      'for add: {"kind":"decision"|"rule","answer":"…"} (why, question, unpicked, source)',
    "--answer <text>": "for apply: write this answer instead of the draft's (kept as edited)",
    "--why <text>": "for apply, a decision: write this why instead of the draft's",
    "--apply": "for apply: write it (without: show what it would write, and write nothing)",
    "--json": "print the result as JSON (list: the pending drafts)",
  },
  exits: { 0: "done, or previewed", 2: "usage, or refused (nothing written)" },
  example: "board draft apply 2 --apply",
};
const fail = (why, next) => refuse("board draft", why, next);
const usage = (why) => usageError("board draft", why);
const WIDTH = 80;
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

// The text of `{answer}`, `{why}`, `{question}` and `{unpicked}` for a template; an unset one reads as
// nothing, and `{why}` is the question when the draft has no why.
function fill(template, draft) {
  const values = {
    answer: draft.answer,
    why: draft.why ?? draft.question ?? "",
    question: draft.question ?? "",
    unpicked: [draft.unpicked ?? []].flat().join(", "),
  };
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!Object.hasOwn(values, name)) throw new WriteError(`unknown placeholder {${name}}`);
    return oneLine(values[name]);
  });
}

// The map a decision draft fills when the workflow file has none: the decision kind (the lifecycle-free kind
// named "decision", else the only kind with a "decision" field) and, of {decision, why, rejected}, the
// fields it has. Null when there is no such kind.
function derivedDef(spec) {
  const kinds = spec.kinds ?? {};
  const free = (k) => !has(kinds[k], "status") && spec.lifecycle?.kind !== k;
  const holders = Object.keys(kinds).filter((k) => has(kinds[k].fields, "decision"));
  const kind =
    has(kinds, "decision") && free("decision") ? "decision" : holders.length === 1 && holders[0];
  if (!kind) return null;
  const slots = { decision: "{answer}", why: "{why}", rejected: "{unpicked}" };
  const map = Object.fromEntries(Object.entries(slots).filter(([f]) => has(kinds[kind].fields, f)));
  return Object.keys(map).length ? { kind, map } : null;
}

function applyDecision(draft, { root, spec, model }, write) {
  let def = own(spec.drafts, "decision");
  let note = "";
  if (!def) {
    def = derivedDef(spec);
    if (!def)
      return {
        exit: 2,
        out: "✗ board draft: no decision kind and no drafts.decision → add drafts.decision to .agentry/workflow.json (format.md § lifecycle and drafts)",
      };
    note = `drafts.decision derived from the ${def.kind} kind (set it in workflow.json to change it)`;
  }
  const lacking = Object.keys(def.map).find((f) => !has(spec.kinds[def.kind].fields, f));
  if (lacking) return fail(`drafts.decision.map names "${lacking}", a field ${def.kind} lacks`);
  const id = nextId([def.kind], { spec, model });
  if (id.exit !== 0) return id;
  let fields;
  try {
    fields = Object.fromEntries(Object.entries(def.map).map(([k, t]) => [k, fill(t, draft)]));
  } catch (e) {
    if (e instanceof WriteError) return fail(`drafts.decision.map: ${e.message}`);
    throw e;
  }
  const args = [def.kind, "--fields", JSON.stringify({ ...fields, id: id.out })];
  const added = addItem(write ? [...args, "--apply"] : args, { root, spec, model });
  return { ...added, note };
}

function applyRule(draft, { root, spec }, write) {
  const heading = spec.conductor?.rules;
  const prompt = spec.conductor?.prompt;
  if (!heading || !prompt)
    return fail("the workflow file has no conductor.rules heading: nowhere to append a rule");
  const line = `- ${oneLine(draft.answer)}`;
  try {
    apply(join(root, prompt), (text) => appendLine(text, { heading, line }), { preview: !write });
  } catch (e) {
    if (e instanceof WriteError) return fail(e.message);
    throw e;
  }
  if (!write)
    return { exit: 0, out: `would add a rule under "${heading}" (${prompt})\n    + ${line}` };
  return { exit: 0, out: `rule added under "${heading}" (${prompt})` };
}

// The checkout `root` is in, when it is not the main one `runRoot` (a linked worktree); else null.
function linkedTree(root, runRoot) {
  const top = topLevel(root);
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return top && real(top) !== real(runRoot) ? top : null;
}

// A note naming the lines of the drafts file that are not drafts, after `out`.
function withTorn(out, runRoot) {
  const torn = drafts.unreadable(runRoot);
  if (!torn.length) return out;
  const which = `line${torn.length > 1 ? "s" : ""} ${torn.join(", ")}`;
  return `${out}\nnote: drafts.jsonl ${which} could not be read; kept as written`;
}

function number(word) {
  return /^[1-9]\d*$/.test(word ?? "") ? Number(word) : null;
}

const FLAGS = ["--apply", "--json", "--answer", "--why"];

// `--answer` and `--why` with their text, out of `argv`: `{ words, edits }`, or `{ error }` for a flag with no
// text after it. An empty text is kept, for the caller to refuse.
function takeEdits(argv) {
  const words = [];
  const edits = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--answer" && flag !== "--why") words.push(flag);
    else if (i + 1 >= argv.length || FLAGS.includes(argv[i + 1]))
      return { error: `${flag} needs the text to write` };
    else edits[flag.slice(2)] = argv[++i];
  }
  return { words, edits };
}

export function run(argv, ctx) {
  const taken = takeEdits(argv);
  if (taken.error) return usage(taken.error);
  const write = taken.words.includes("--apply");
  const json = taken.words.includes("--json");
  const words = taken.words.filter((a) => a !== "--apply" && a !== "--json");
  const [action, ...rest] = words;
  const runRoot = mainRoot(ctx.root) ?? ctx.root;
  // `text` as printed, or `data` as JSON with `--json`.
  const done = (text, data) => ({
    exit: 0,
    out: json ? JSON.stringify(data) : withTorn(text, runRoot),
  });
  if (write && action !== "apply") return usage("--apply goes with apply <n>");
  if (Object.keys(taken.edits).length && action !== "apply")
    return usage("--answer and --why go with apply <n>");
  const blank = Object.keys(taken.edits).find((k) => !taken.edits[k].trim());
  if (blank) return fail(`--${blank} must be some text`);
  if (action === "list") {
    if (rest.length) return usage("list takes nothing more");
    const open = drafts.pending(runRoot);
    const shown = open.length
      ? open
          .map((d) =>
            fit(`${String(d.n).padStart(3)}  ${d.kind.padEnd(8)}  ${oneLine(d.answer)}`, WIDTH),
          )
          .join("\n")
      : "no pending drafts";
    return done(shown, { pending: open, unreadable: drafts.unreadable(runRoot) });
  }
  if (action === "add") {
    const at = rest.indexOf("--fields");
    if (at < 0 || rest.length !== 2) return usage("add needs --fields '<draft>'");
    let given;
    try {
      given = JSON.parse(rest[at + 1]);
    } catch (e) {
      return fail(`--fields is not valid JSON (${e.message})`);
    }
    const why = drafts.problem(given);
    if (why) return fail(why);
    const d = drafts.add(runRoot, given);
    return {
      exit: 0,
      out: json ? JSON.stringify(d) : `drafted ${d.n}: ${d.kind}, ${fit(oneLine(d.answer), 50)}`,
    };
  }
  if (action !== "drop" && action !== "apply")
    return usage("needs add, list, drop <n> or apply <n>");
  const n = number(rest[0]);
  if (n === null || rest.length !== 1) return usage(`${action} needs a draft number`);
  const draft = drafts.pending(runRoot).find((d) => d.n === n);
  if (!draft) return fail(`no pending draft ${n}`, "board draft list");
  if (action === "drop") {
    drafts.mark(runRoot, n, "dropped");
    return done(`dropped draft ${n}`, { n, state: "dropped" });
  }
  const tree = linkedTree(ctx.root, runRoot);
  if (tree)
    return fail(
      `draft apply edits the main checkout's board, and ${tree} is a worktree: run it from ${runRoot}`,
    );
  if (draft.kind === "rule" && "why" in taken.edits)
    return usage("--why goes with a decision draft");
  const used = { ...draft, ...taken.edits };
  const wrote =
    draft.kind === "decision" ? applyDecision(used, ctx, write) : applyRule(used, ctx, write);
  if (wrote.exit !== 0) return wrote;
  const body = wrote.out.split("\n").filter((l) => l !== PREVIEW);
  const note = wrote.note ? [wrote.note] : [];
  if (!write)
    return done([`draft ${n}:`, ...body, ...note, PREVIEW].join("\n"), {
      n,
      applied: false,
      body,
    });
  // An edited text is kept on the draft's line, with the text it replaced.
  const changed = Object.keys(taken.edits).filter((k) => taken.edits[k] !== (draft[k] ?? ""));
  const edit = changed.length
    ? { ...taken.edits, edited: Object.fromEntries(changed.map((k) => [k, draft[k] ?? ""])) }
    : {};
  drafts.mark(runRoot, n, "applied", edit);
  return done([`applied draft ${n}: ${body[0]}`, ...note].join("\n"), {
    n,
    applied: true,
    body,
  });
}
