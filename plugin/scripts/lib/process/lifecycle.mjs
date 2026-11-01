// lifecycle — the one place a harness event becomes board writes (plan R1b §3.1): the status, the
// verdict, the commit cell and the handoff line, as the process file's `lifecycle` maps them. Every
// edit of one event goes through one `write.applyAll` (all or nothing, re-read guard); a refusal is a
// `WriteError` and nothing is written. No `lifecycle` key: nothing is written, every step is skipped
// "lifecycle off", so a read-only repo stays read-only.
//
// Events: dispatched · built · failed → the status `on` maps them to. verdict (data.verdict) → the
// verdict field; FAIL also applies "failed"; a pass leaves the status (only the merge makes a task
// done, A23). merged (data.shas, first landed first; data.summary) → `on.merged`, the commit cell
// `<first>` or `<first>…<last>` (short SHAs) and the handoff line in the parent's file, naming the
// first. A `writes` file is relative to the git root. A step whose edit changes nothing (already set,
// the handoff line already there) is in `skipped`, not `writes`.
import { execFileSync } from "node:child_process";
import { join, posix } from "node:path";
import * as md from "./markdown.mjs";
import { escapesRoot, fillHandoff, handoffRejection, own } from "./spec.mjs";
import { WriteError, appendLine, applyAll, setCell, setKey } from "./write.mjs";

export const EVENTS = ["dispatched", "built", "failed", "verdict", "merged"];
export const VERDICTS = ["PASS", "PASS WITH NOTES", "FAIL"];
// What each event writes, and the data it takes (anything else is refused).
const STEPS = {
  dispatched: { steps: () => ["status"], takes: [] },
  built: { steps: () => ["status"], takes: [] },
  failed: { steps: () => ["status"], takes: [] },
  verdict: {
    steps: (data) => (data.verdict === "FAIL" ? ["verdict", "status"] : ["verdict"]),
    takes: ["verdict"],
  },
  merged: { steps: () => ["status", "commit", "handoff"], takes: ["shas", "summary"] },
};
const SHA = /^[0-9a-f]{7,40}$/;

const refuse = (message) => {
  throw new WriteError(message);
};
const has = (obj, key) => Object.hasOwn(obj, key);

/** The handoff line for one task: the process file's `lifecycle.handoff` with `{id}`, `{sha}` and
 *  `{summary}` filled, each on one line. */
export function renderHandoff(spec, { id, sha, summary }) {
  const template = spec.lifecycle?.handoff;
  if (typeof template !== "string") refuse("the process file has no lifecycle.handoff template");
  return fillHandoff(template, { id, sha, summary });
}

// The event's data, checked: only the keys it takes (an undefined one is not given), a known
// verdict, lower-case hex SHAs.
function checkData(event, data) {
  for (const [key, value] of Object.entries(data))
    if (value !== undefined && !STEPS[event].takes.includes(key))
      refuse(`${event} takes no "${key}"`);
  if (event === "verdict" && !VERDICTS.includes(data.verdict))
    refuse(`verdict needs one of ${VERDICTS.map((v) => `"${v}"`).join(", ")}`);
  if (event !== "merged") return;
  const shas = data.shas;
  if (!Array.isArray(shas) || shas.length === 0) refuse("merged needs the landed commits (shas)");
  for (const sha of shas)
    if (typeof sha !== "string" || !SHA.test(sha))
      refuse(`"${sha}" is not a commit SHA (7 to 40 lower-case hex)`);
  if (data.summary !== undefined && typeof data.summary !== "string")
    refuse("summary should be text");
}

// git's answer to `args` in `root`, trimmed; null when it fails.
function ask(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// The shortest prefix of `sha`, from 7 characters, that names that commit and no other object of any
// type (a tag or a blob sharing the prefix would make the board's checker fail on it). `sha` itself
// must be a commit: `cat-file -t` does not peel a tag to the commit it points at.
function shortOf(root, sha) {
  if (ask(root, ["cat-file", "-t", sha]) !== "commit")
    return refuse(
      `${sha} is not a commit in git (a tag or another object, or a prefix not unique)`,
    );
  const full = ask(root, ["rev-parse", "--verify", sha]);
  for (let n = 7; n < full.length; n++)
    if (ask(root, ["rev-parse", `--disambiguate=${full.slice(0, n)}`]) === full)
      return full.slice(0, n);
  return full;
}

/**
 * Apply one harness event to item `id` of the lifecycle's kind. `model` is the board as read
 * (`readProcess`). Returns { writes: [{ file, what }], skipped: [{ what, why }] }; throws a
 * `WriteError` (nothing written) on a bad event, bad data, an id not on the board once, or an edit
 * the board refuses.
 */
export function applyEvent({ root, spec, model, event, id, data = {} }) {
  if (!has(STEPS, event)) refuse(`unknown event "${event}" (${EVENTS.join(", ")})`);
  checkData(event, data);
  const steps = STEPS[event].steps(data);
  const life = spec.lifecycle;
  if (!life) return { writes: [], skipped: steps.map((what) => ({ what, why: "lifecycle off" })) };

  const name = life.kind;
  const kind = spec.kinds[name];
  const items = (own(model.kinds, name)?.items ?? []).filter((i) => i.id === id);
  if (items.length !== 1)
    refuse(`${items.length ? "several" : "no"} ${name} "${id}" on the board; nothing written`);
  const [item] = items;
  const write = life.write ?? {};
  const shas = event === "merged" ? data.shas.map((sha) => shortOf(root, sha)) : [];

  const edits = [];
  const planned = []; // { step, file, what, changed } per edit, `changed` set when the edit runs
  const skipped = [];
  const place = (step, file, edit, what) => {
    if (escapesRoot(spec.root, file)) refuse(`${file} leaves the repository`);
    const entry = { step, file: posix.join(spec.root, file), what, changed: false };
    planned.push(entry);
    edits.push({
      file: join(root, spec.root, file),
      edit: (text) => {
        const out = edit(text);
        entry.changed = out !== text;
        return out;
      },
    });
  };
  // One field of the item: its table cell, or its frontmatter key for a one-file-per-item kind.
  const setField = (step, fieldName, value) => {
    const { column } = kind.fields[fieldName];
    const table = kind.at.table !== undefined;
    const edit = table
      ? (text) =>
          setCell(text, {
            heading: kind.at.heading,
            idColumn: kind.id.column,
            idMatch: kind.id.match,
            id,
            column,
            value,
          })
      : (text) => setKey(text, { key: column, value });
    place(step, table ? kind.at.table : item.file, edit, `${fieldName} → ${value}`);
  };
  const values = {
    status: () => own(life.on, event === "verdict" ? "failed" : event),
    verdict: () => data.verdict,
    commit: () => (shas.length === 1 ? shas[0] : `${shas[0]}…${shas.at(-1)}`),
  };

  for (const step of steps) {
    const target = own(write, step);
    if (typeof target !== "string") {
      skipped.push({ what: step, why: `no lifecycle.write.${step}` });
      continue;
    }
    if (step === "handoff") {
      handoff({
        spec,
        model,
        item,
        sha: shas[0],
        line: renderLine(spec, item, shas, data),
        target,
        place,
      });
      continue;
    }
    const value = values[step]();
    if (typeof value !== "string") {
      const on = event === "verdict" ? "failed" : event;
      skipped.push({ what: step, why: `no lifecycle.on.${on}` });
      continue;
    }
    setField(step, target, value);
  }
  if (edits.length) applyAll(edits);
  const writes = [];
  for (const { step, file, what, changed } of planned)
    if (changed) writes.push({ file, what });
    else skipped.push({ what: step, why: step === "handoff" ? "already there" : "already set" });
  return { writes, skipped };
}

function renderLine(spec, item, shas, data) {
  if (typeof data.summary !== "string" || !data.summary.trim())
    refuse("merged writes a handoff line, which needs a summary");
  return renderHandoff(spec, { id: item.id, sha: shas[0], summary: data.summary });
}

// Is `line` (as written) already a bold-lead line of the section under `heading` in `text`?
function hasLine(text, heading, line) {
  const sec = md.section(text, heading);
  return !!sec && md.boldLeads(text, sec).some((l) => l.text.trim() === line.trim());
}

// The handoff line, appended to the section `target` (`parent.file:<section>`) of the item's parent's
// own file, after the checker's own rule has accepted that very line for this id and commit. A line
// already there as written is not added twice: that is asked of the file as re-read inside the edit,
// so a line put there since the board was read counts too.
function handoff({ spec, model, item, sha, line, target, place }) {
  const section = target.slice("parent.file:".length);
  const fields = Object.values(spec.kinds[item.kind].fields ?? {});
  const refs = [fields.find((f) => f.role === "parent")?.ref ?? []].flat();
  const parent = (own(model.index, item.parent) ?? []).find((p) => refs.includes(p.kind));
  if (!parent) refuse(`${item.id} has no parent on the board to write its handoff line to`);
  const def = own(spec.kinds[parent.kind].file?.sections, section);
  if (def?.as !== "bold-lead") refuse(`${parent.kind} has no bold-lead section "${section}"`);
  if (!parent.own)
    refuse(`${parent.kind} ${parent.id} has no file (${spec.kinds[parent.kind].file?.glob})`);
  const found = handoffRejection(spec, line, { id: item.id, sha, parent: parent.id });
  if (found)
    refuse(`the handoff line ${JSON.stringify(line)} would fail ${found}; nothing written`);
  const edit = (text) =>
    hasLine(text, def.heading, line) ? text : appendLine(text, { heading: def.heading, line });
  place("handoff", parent.own.path, edit, `handoff line under "${def.heading}"`);
}
