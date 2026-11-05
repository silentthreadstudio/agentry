#!/usr/bin/env node
// measure-session — dev-only: the live-week numbers from Claude Code transcripts (+ exec ledgers). Plan R1b §9.
//
//   node scripts/measure-session.mjs --transcripts <dir|files…> [--ledger <dir>…] [--since <date>] [--json]
//
// Counts only. No transcript text is printed or kept: each line is parsed, tallied and dropped. Transcripts are
// read-only and streamed line by line (some are hundreds of MB). Node built-ins only.
//
//   --transcripts  directories (walked for *.jsonl, subagents/ included) and/or .jsonl files
//   --ledger       a `.agentry/run/process/ledger` dir, or the checkout root that holds one (repeatable)
//   --since        keep only events stamped on or after this date (a session counts if it has one)
//
// Definitions:
//   work dispatch  an Agent/Task call to implementer, designer, verifier or general-purpose
//   marked         its prompt has an `agentry-task:` marker (findMarker). Via exec = marked and, when ledgers are
//                  given, a ledger of origin "exec" for that id (an "adopted" ledger is a bypass)
//   merges         `lane merge` = distinct task ids merged through it; by hand = `git cherry-pick` calls
//   typed / conductor  `/agentry:start` typed by the user vs. run by an agent through the Skill tool
//   nudges         drift kinds named in the output of a Bash call that ran a `status` command
//   recall         `agentry mem recall` Bash calls, and the memory MCP's `memory_recall` in older transcripts
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { findMarker } from "../plugin/scripts/lib/lane/report.mjs";

// A Bash call that runs `agentry mem recall` (or the script behind it).
const RECALL_COMMAND = /\bmem(?:\.mjs)?["']?\s+recall(?![\w-])/;
const WORK_TYPES = new Set(["implementer", "designer", "verifier", "general-purpose"]);
const NUDGE_KINDS = [
  "unlisted-worktree",
  "started-by-hand",
  "merged-by-hand",
  "verified-not-merged",
  "episode-pending",
];
// Records that are not messages; their lines can be huge (api-request blobs) and are never parsed.
const SKIP_PREFIX =
  /^\{"type":"(?:api-request|file-history|cost-state|last-prompt|mode|permission|atis)/;
const BRIEF_FACT = /^\s*[-*]\s+\[[^\]\n]+ · [^\]\n]+\]/;

export const usage =
  "usage: measure-session --transcripts <dir|files…> [--ledger <dir>…] [--since <date>] [--json]";

// ---- arguments ----------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { transcripts: [], ledgers: [], since: null, json: false };
  let list = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--transcripts") list = opts.transcripts;
    else if (a === "--ledger") list = opts.ledgers;
    else if (a === "--since") {
      const v = argv[++i];
      if (!v || Number.isNaN(Date.parse(v))) return { error: `--since needs a date (got ${v})` };
      opts.since = new Date(v).toISOString();
      list = null;
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else if (list) list.push(a);
    else return { error: `unexpected argument ${a}` };
  }
  if (!opts.transcripts.length) return { error: "--transcripts needs at least one path" };
  return opts;
}

function jsonlFiles(paths) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p).sort()) walk(join(p, name));
    else if (p.endsWith(".jsonl")) out.push(p);
  };
  for (const p of paths) walk(resolve(p));
  return out;
}

// ---- transcripts --------------------------------------------------------------------------------------

const newSession = () => ({
  recalls: 0,
  startTyped: false,
  startConductor: false,
});

const bump = (obj, key, n = 1) => {
  obj[key] = (obj[key] ?? 0) + n;
};

const resultText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n")
      : "";

/** Tally one message line into `t` (the running totals). Unknown shapes are ignored. */
function tally(t, o) {
  const sid = o.sessionId ?? "unknown";
  t.sessions[sid] ??= newSession();
  const session = t.sessions[sid];
  const content = o.message?.content;

  if (o.type === "user") {
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.map((b) => b?.text)
          : [];
    for (const text of texts)
      if (
        typeof text === "string" &&
        /<command-name>\s*\/?agentry:start\s*<\/command-name>/.test(text)
      )
        session.startTyped = true;
    if (Array.isArray(content))
      for (const b of content) {
        if (b?.type !== "tool_result" || !t.statusCalls.has(b.tool_use_id)) continue;
        const text = resultText(b.content);
        for (const kind of NUDGE_KINDS) if (text.includes(kind)) bump(t.nudges, kind);
      }
    return;
  }
  if (o.type !== "assistant" || !Array.isArray(content)) return;

  for (const b of content) {
    if (b?.type !== "tool_use") continue;
    const input = b.input ?? {};
    if (b.name === "Agent" || b.name === "Task") {
      const type = String(input.subagent_type ?? "").replace(/^agentry:/, "");
      if (!WORK_TYPES.has(type)) continue;
      const marker = findMarker(input.prompt);
      t.dispatches.push({ type, id: marker?.id ?? null, role: marker?.role ?? null });
    } else if (b.name === "Bash" && typeof input.command === "string") {
      const cmd = input.command;
      if (/\bgit\b[^\n|;&]*\bcherry-pick\b(?![^\n|;&]*--(?:abort|quit|continue))/.test(cmd))
        t.cherryPicks++;
      const merge = /\blane(?:\.mjs)?["']?\s+merge\s+([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(cmd);
      if (merge) t.laneMerges.add(merge[1]);
      if (/\bstatus\b/.test(cmd)) t.statusCalls.add(b.id);
      if (RECALL_COMMAND.test(cmd)) session.recalls++;
    } else if (b.name === "Skill" && /^(?:agentry:)?start$/.test(String(input.skill ?? ""))) {
      session.startConductor = true;
    } else if (/memory_recall$/.test(b.name)) {
      // the memory MCP's tool, in transcripts from before `agentry mem`
      session.recalls++;
    }
  }
}

/** Stream every transcript file into one set of totals. */
async function scanTranscripts(files, since) {
  const t = {
    files: files.length,
    sessions: {},
    dispatches: [],
    cherryPicks: 0,
    laneMerges: new Set(),
    statusCalls: new Set(),
    nudges: {},
  };
  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      if (!line || SKIP_PREFIX.test(line)) continue;
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (since && !(typeof o.timestamp === "string" && o.timestamp >= since)) continue;
      tally(t, o);
    }
  }
  return t;
}

// ---- ledgers ------------------------------------------------------------------------------------------

function ledgerDir(dir) {
  const nested = join(dir, ".agentry", "run", "process", "ledger");
  return existsSync(nested) ? nested : dir;
}

function readLedgers(dirs) {
  const out = new Map();
  for (const d of dirs) {
    const dir = ledgerDir(resolve(d));
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      try {
        const ledger = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (ledger?.v === 1 && typeof ledger.id === "string" && Array.isArray(ledger.rounds))
          out.set(ledger.id, ledger);
      } catch {
        /* an unreadable ledger is left out */
      }
    }
  }
  return out;
}

function factsIn(briefPath) {
  try {
    return readFileSync(briefPath, "utf8")
      .split("\n")
      .filter((l) => BRIEF_FACT.test(l)).length;
  } catch {
    return null;
  }
}

function fromLedgers(ledgers) {
  const counted = (r) => typeof r.verdict === "string" && !r.void;
  const guards = { mainTouched: 0, dirty: 0, noCommits: 0, tipMoved: 0, stopped: 0 };
  let passed = 0;
  let passedWithFinal = 0;
  let atStop = 0;
  const perTask = [];
  const briefs = { dispatches: 0, withFacts: 0, facts: 0, unreadable: 0 };
  for (const ledger of ledgers.values()) {
    const verdicts = ledger.rounds.filter(counted);
    perTask.push(verdicts.length);
    if (verdicts.length >= 3) atStop++;
    if (verdicts.some((r) => r.verdict.startsWith("PASS"))) {
      passed++;
      if (ledger.rounds.some((r) => r.final === true && counted(r))) passedWithFinal++;
    }
    if (ledger.state === "stopped") guards.stopped++;
    for (const r of ledger.rounds) {
      if (r.void) guards.tipMoved++;
      for (const g of r.guards ?? []) {
        if (g.startsWith("main touched")) guards.mainTouched++;
        else if (g.startsWith("uncommitted")) guards.dirty++;
        else if (g.startsWith("no commits")) guards.noCommits++;
      }
      if (typeof r.brief === "string") {
        briefs.dispatches++;
        const n = factsIn(r.brief);
        if (n === null) briefs.unreadable++;
        else {
          briefs.facts += n;
          if (n > 0) briefs.withFacts++;
        }
      }
    }
  }
  return {
    tasks: ledgers.size,
    verifyRounds: stats(perTask),
    tasksAtThreeVerdicts: atStop,
    freshFinal: { passed, withFinal: passedWithFinal, rate: ratio(passedWithFinal, passed) },
    guardTrips: guards,
    briefs,
  };
}

// ---- report -------------------------------------------------------------------------------------------

const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
const stats = (xs) => ({
  tasks: xs.length,
  mean: xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null,
  max: xs.length ? Math.max(...xs) : null,
});

export function summarize(t, ledgers) {
  const sessions = Object.values(t.sessions);
  const marked = t.dispatches.filter((d) => d.id);
  const viaExec = ledgers ? marked.filter((d) => ledgers.get(d.id)?.origin === "exec") : marked;
  const verifyCounts = {};
  for (const d of marked)
    if (d.type === "verifier" || (d.role && d.role !== "build")) bump(verifyCounts, d.id);
  const lane = t.laneMerges.size;
  return {
    sessions: sessions.length,
    files: t.files,
    dispatches: {
      work: t.dispatches.length,
      marked: marked.length,
      viaExec: viaExec.length,
      viaExecShare: ratio(viaExec.length, t.dispatches.length),
      byType: t.dispatches.reduce((acc, d) => {
        bump(acc, d.type);
        return acc;
      }, {}),
    },
    merges: {
      laneTasks: lane,
      handCherryPicks: t.cherryPicks,
      laneShare: ratio(lane, lane + t.cherryPicks),
    },
    recall: {
      calls: sessions.reduce((a, s) => a + s.recalls, 0),
      perSession: ratio(
        sessions.reduce((a, s) => a + s.recalls, 0),
        sessions.length,
      ),
      sessionsWithRecall: sessions.filter((s) => s.recalls > 0).length,
    },
    verifyDispatchesPerTask: stats(Object.values(verifyCounts)),
    nudges: t.nudges,
    start: {
      typed: sessions.filter((s) => s.startTyped).length,
      conductor: sessions.filter((s) => s.startConductor && !s.startTyped).length,
      neither: sessions.filter((s) => !s.startTyped && !s.startConductor).length,
    },
    ledgers: ledgers ? fromLedgers(ledgers) : null,
  };
}

const pct = (r) => (r === null ? "n/a" : `${(r * 100).toFixed(1)} %`);

export function render(s) {
  const rows = [
    ["sessions / files", `${s.sessions} / ${s.files}`],
    [
      "work dispatches",
      `${s.dispatches.work} (${
        Object.entries(s.dispatches.byType)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      })`,
    ],
    ["  with agentry-task marker", `${s.dispatches.marked}`],
    ["  via exec", `${s.dispatches.viaExec} = ${pct(s.dispatches.viaExecShare)}`],
    ["merges via lane merge (tasks)", `${s.merges.laneTasks}`],
    ["hand git cherry-pick calls", `${s.merges.handCherryPicks}`],
    ["  lane merge share", pct(s.merges.laneShare)],
    [
      "memory recall calls",
      `${s.recall.calls} (${s.recall.perSession ?? "n/a"} per session; ${s.recall.sessionsWithRecall} sessions with one)`,
    ],
    [
      "verify dispatches per marked task",
      `mean ${s.verifyDispatchesPerTask.mean ?? "n/a"}, max ${s.verifyDispatchesPerTask.max ?? "n/a"} over ${s.verifyDispatchesPerTask.tasks} tasks`,
    ],
    ["nudges seen", NUDGE_KINDS.map((k) => `${k} ${s.nudges[k] ?? 0}`).join(", ")],
    [
      "/agentry:start",
      `typed ${s.start.typed}, by conductor ${s.start.conductor}, neither ${s.start.neither}`,
    ],
  ];
  const l = s.ledgers;
  if (l) {
    rows.push(
      ["ledgers: tasks", `${l.tasks}`],
      [
        "  verdicts per task",
        `mean ${l.verifyRounds.mean ?? "n/a"}, max ${l.verifyRounds.max ?? "n/a"}; ${l.tasksAtThreeVerdicts} at the 3-verdict stop`,
      ],
      [
        "  fresh-final rate",
        `${l.freshFinal.withFinal}/${l.freshFinal.passed} = ${pct(l.freshFinal.rate)}`,
      ],
      [
        "  guard trips",
        Object.entries(l.guardTrips)
          .map(([k, v]) => `${k} ${v}`)
          .join(", "),
      ],
      [
        "  facts injected",
        `${l.briefs.facts} in ${l.briefs.withFacts}/${l.briefs.dispatches} briefs (${l.briefs.unreadable} unreadable)`,
      ],
    );
  }
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

// ---- main ---------------------------------------------------------------------------------------------

export async function measure(opts) {
  const files = jsonlFiles(opts.transcripts);
  const t = await scanTranscripts(files, opts.since);
  return summarize(t, opts.ledgers.length ? readLedgers(opts.ledgers) : null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`${basename(process.argv[1])}: ${opts.error}\n${usage}`);
    process.exit(2);
  }
  try {
    const summary = await measure(opts);
    console.log(opts.json ? JSON.stringify(summary, null, 2) : render(summary));
  } catch (err) {
    console.error(`${basename(process.argv[1])}: ${err.message}`);
    process.exit(1);
  }
}
