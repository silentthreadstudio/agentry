// board draft add --fields '{…}' | list | drop <n> | apply <n> — the owner's calls the conductor caught in
// conversation, held until the owner says OK (plan R1b §5). `add` keeps a draft in `.agentry/run`, `list` shows
// the pending ones, `drop` forgets one, and `apply` writes it: a decision through `next-id` and `add` with the
// workflow file's `drafts.decision.map` (`{answer}`, `{question}`, `{unpicked}`), a rule as a line under
// `conductor.rules` in the conductor prompt. Only `apply` writes to the repo, and the conductor runs it only
// after the owner's OK. The drafts live in the main checkout, so `apply` edits the main checkout's board: from
// inside a linked worktree it refuses rather than write the edit in one checkout and the state in another. A
// line of the drafts file that is not a draft is kept as written and named in the output of list, drop and
// apply. `apply <n>` alone shows what it would write and writes nothing; `apply <n> --apply` writes it
// (A39). `add` and `drop` write only the drafts file under `.agentry/run`, never the repo: holding a draft
// is their job, and the drafts are the preview.
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = done or previewed, 2 = usage or refusal
// (nothing written)
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW, refuse, usageError } from "../../cli/help.mjs";
import { git, mainRoot } from "../../lane/worktree.mjs";
import * as drafts from "../drafts.mjs";
import { fit } from "../render.mjs";
import { own } from "../spec/shape.mjs";
import { WriteError, appendLine, apply } from "../write.mjs";
import { run as addItem } from "./add.mjs";
import { run as nextId } from "./next-id.mjs";

export const help = {
  usage: [
    "draft add --fields '{…}' [--json]",
    "draft list [--json]",
    "draft drop <n> [--json]",
    "draft apply <n> [--apply] [--json]",
  ],
  purpose: "The owner's calls caught in conversation, held until the owner says OK.",
  args: {
    "add|list|drop|apply": "keep a draft, show the pending ones, forget one, write one",
    "<n>": "a pending draft's number (see draft list)",
  },
  flags: {
    "--fields <json>":
      'for add: {"kind":"decision"|"rule","answer":"…"} (question, unpicked, source)',
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

// The text of `{answer}`, `{question}` and `{unpicked}` for a template; an unset one reads as nothing.
function fill(template, draft) {
  const values = {
    answer: draft.answer,
    question: draft.question ?? "",
    unpicked: [draft.unpicked ?? []].flat().join(", "),
  };
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!Object.hasOwn(values, name)) throw new WriteError(`unknown placeholder {${name}}`);
    return oneLine(values[name]);
  });
}

function applyDecision(draft, { root, spec, model }, write) {
  const def = own(spec.drafts, "decision");
  if (!def)
    return fail("the workflow file has no drafts.decision: nothing says how a decision is filled");
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
  return addItem(write ? [...args, "--apply"] : args, {
    root,
    spec,
    model,
  });
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
  const res = git(root, ["rev-parse", "--show-toplevel"]);
  const top = res.status === 0 ? res.stdout.trim() : null;
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

export function run(argv, ctx) {
  const write = argv.includes("--apply");
  const json = argv.includes("--json");
  const words = argv.filter((a) => a !== "--apply" && a !== "--json");
  const [action, ...rest] = words;
  const runRoot = mainRoot(ctx.root) ?? ctx.root;
  // `text` as printed, or `data` as JSON with `--json`.
  const done = (text, data) => ({
    exit: 0,
    out: json ? JSON.stringify(data) : withTorn(text, runRoot),
  });
  if (write && action !== "apply") return usage("--apply goes with apply <n>");
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
  const wrote =
    draft.kind === "decision" ? applyDecision(draft, ctx, write) : applyRule(draft, ctx, write);
  if (wrote.exit !== 0) return wrote;
  const body = wrote.out.split("\n").filter((l) => l !== PREVIEW);
  if (!write)
    return done([`draft ${n}:`, ...body, PREVIEW].join("\n"), { n, applied: false, body });
  drafts.mark(runRoot, n, "applied");
  return done(`applied draft ${n}: ${body[0]}`, { n, applied: true, body });
}
