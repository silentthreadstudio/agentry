// memory-recall — the dependency-free half of Agentry's priming: read the file-store, rank facts
// against a task, and render the few that earned a slot.
//
// WHY THIS EXISTS. Every specialist's prompt says some variant of "you are primed with recalled gotchas
// — use them; recall further only for the specific symbol you're touching." Nothing primed them: the
// SessionStart hook exits immediately for workers, and injected only COUNTS ("55 facts, 19 episodes")
// even for the conductor. Agents were told recall had already happened and were explicitly discouraged
// from recalling, so the memory MCP went unused. This module makes the sentence true.
//
// It reads the FILE STORE directly (text is truth — doc 07) rather than going through the MCP: a hook
// must be fast, synchronous, and dependency-free, and the files are the same source the MCP indexes.
// Ranking mirrors `packages/memory/src/domain/ranking.ts` — `relevance × confidence × (1 + usefulness)`
// — so a hook-primed fact and an MCP-recalled one agree about what matters.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The two memory roots, project first (a repo's own facts outrank the global ones on ties). */
export function memoryRoots(projectDir) {
  return [
    { label: "project", dir: join(projectDir, ".agentry", "memory") },
    { label: "global", dir: join(homedir(), ".agentry", "memory") },
  ];
}

/** Read `.agentry/config.json` (project, then global) for the `memory` block. Never throws — a missing
 *  or malformed config is the shipped default, not an error that breaks a subagent launch. */
export function readMemoryConfig(projectDir) {
  const defaults = { prime: "conductor", primeLimit: 5, captureCorrections: false };
  for (const path of [join(projectDir, ".agentry", "config.json"), join(homedir(), ".agentry", "config.json")]) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const memory = parsed && typeof parsed === "object" ? parsed.memory : undefined;
      if (memory && typeof memory === "object") return { ...defaults, ...memory };
    } catch {
      /* malformed config — fall through to the defaults */
    }
  }
  return defaults;
}

// Parse just enough frontmatter for ranking: the scalar fields, plus `tags`/`provenance` lists. A folded
// or quoted multi-line value (`why:`) is skipped rather than half-parsed — it never drives ranking.
function parseFact(text, source) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(4, end).split("\n");
  const body = text.slice(end + 4).trim();

  const fact = { confidence: 0.5, usefulness: 0, status: "active", tags: [], provenance: [], body, source };
  let list = null;
  for (const line of head) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      fact[list].push(item[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (key === "tags" || key === "provenance") {
      list = key;
      continue;
    }
    list = null;
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if (key === "confidence" || key === "usefulness") fact[key] = Number(value) || 0;
    else if (key === "id" || key === "type" || key === "scope" || key === "status") fact[key] = value;
  }
  return fact;
}

/** Every active fact across both roots. Superseded/archived records never reach recall. */
export function readFacts(projectDir) {
  const facts = [];
  for (const root of memoryRoots(projectDir)) {
    const dir = join(root.dir, "facts");
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of entries) {
      try {
        const fact = parseFact(readFileSync(join(dir, file), "utf8"), root.label);
        if (fact && fact.status === "active") facts.push(fact);
      } catch {
        /* an unreadable record is skipped, never fatal */
      }
    }
  }
  return facts;
}

// Word tokens, lowercased. Path-ish tokens are ALSO split on separators so `packages/memory/src/db.ts`
// contributes `packages`, `memory`, `src`, `db`, `ts` — the index the MCP uses is full-text only, so a
// brief that names files must still be able to reach a fact that names the same files.
// The relevance a fact must clear to be worth someone's context. Tuned against the real store: a task
// naming a subsystem or a file clears it comfortably; an unrelated prompt clears nothing.
const MIN_RELEVANCE = 0.18;

const tokenize = (text) => (String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []);

// Tokens that carry no signal — they match nearly every fact and would swamp the real terms. Two
// families: ordinary English glue, and STRUCTURAL PATH SEGMENTS. The second matters more than it looks:
// a brief naming `packages/workbench/server/src/transport/http.ts` otherwise scores every fact whose
// provenance contains `packages` and `src` — which is most of them — and the identifying words
// (`workbench`, `transport`) get outvoted by the scaffolding around them.
const STOP = new Set(
  ("the a an and or of to in for on with is are be this that it its as at by from you your we our " +
    "task run use using make made do does done into then than when what which who how why not no " +
    "add adds added new file files code work works " +
    "packages package src lib dist test tests index main app source ts tsx js jsx mjs cjs json md").split(" "),
);

/**
 * Rank facts against a task description.
 *
 * Relevance is IDF-weighted token overlap, not a raw hit count. Raw counting fails badly here: a brief
 * about "the workbench transport path routing" scores a long, unrelated fact highest simply because it
 * happens to contain `path`, `base` and `route` — common words carry no signal, and long records match
 * more of them. Weighting each token by how RARE it is across the store (`log(N/df)`) makes distinctive
 * terms — `workbench`, `transport`, `chokidar` — decide the ranking, and dividing by the square root of
 * the fact's length stops a long record from winning on breadth alone.
 *
 * A hit in `provenance` (a file path the task actually names) counts double: paths are the highest-
 * precision signal a brief carries. The final score reuses the store's formula:
 * `relevance × confidence × (1 + usefulness)`.
 */
export function rankFacts(facts, task, limit) {
  const queryTokens = [...new Set(tokenize(task))].filter((t) => t.length > 2 && !STOP.has(t));
  if (queryTokens.length === 0 || facts.length === 0) return [];

  // Index each fact once: its searchable token set, its path tokens, and its length (for damping).
  const indexed = facts.map((fact) => {
    const body = tokenize(fact.body);
    const bodyTokens = new Set([...body, ...tokenize(fact.tags.join(" "))]);
    return { fact, bodyTokens, pathTokens: new Set(tokenize(fact.provenance.join(" "))), length: body.length };
  });

  // Document frequency over the corpus we actually have — small enough to count directly.
  const df = new Map();
  for (const entry of indexed) {
    for (const token of queryTokens) {
      if (entry.bodyTokens.has(token) || entry.pathTokens.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const idf = (token) => Math.log(indexed.length / (1 + (df.get(token) ?? 0))) + 1;
  const ideal = queryTokens.reduce((sum, t) => sum + idf(t) * 2, 0); // every token hit on a path

  const scored = [];
  for (const entry of indexed) {
    let weight = 0;
    for (const token of queryTokens) {
      if (entry.pathTokens.has(token)) weight += idf(token) * 2;
      else if (entry.bodyTokens.has(token)) weight += idf(token);
    }
    if (weight === 0) continue;
    const relevance = Math.min(1, weight / (ideal * Math.sqrt(Math.max(entry.length, 1) / 100)));
    // A FLOOR, not just a ranking. Without it every prompt gets its top-N filled by whatever matched
    // weakest-but-nonzero — and priming that injects unrelated facts into every turn is precisely the
    // noise that "recall is task-specific, never a warm-set dump" exists to prevent. Below the floor the
    // honest answer is silence.
    if (relevance < MIN_RELEVANCE) continue;
    const { confidence, usefulness } = entry.fact;
    scored.push({ fact: entry.fact, score: relevance * (confidence || 0.5) * (1 + (usefulness || 0)) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.fact);
}

/** Render facts for injection: the id (so the agent can cite it in `used_memories`), its type, and the
 *  body. Bodies are truncated — priming is a nudge with substance, not a context dump. */
export function renderFacts(facts, heading) {
  if (facts.length === 0) return "";
  const lines = [heading];
  for (const fact of facts) {
    const body = fact.body.length > 600 ? `${fact.body.slice(0, 599)}…` : fact.body;
    lines.push(`- [${fact.type ?? "fact"} · ${fact.id ?? "?"}] ${body.replace(/\n+/g, " ")}`);
  }
  lines.push(
    "Cite any of these that changed what you did in `used_memories`. Recall more only for the specific symbol you touch.",
  );
  return lines.join("\n");
}
