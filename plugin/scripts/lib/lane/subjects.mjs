// subjects — the workflow file's `commits` rules applied to commit messages: a subject longer than
// `subjectMax` (code points), one `subjectPattern` does not match, a message a `forbid` pattern matches.
//
//   checkCommits  rules + commits → the commits that break one, with the first rule broken (pure)
//   readCommits   the messages of commits in a repo, oldest first as given
//   brokenIn      the two together: the commits among `shas` that break the spec's rules
//   learnRules    the rules a history of subjects keeps: its Conventional Commits types, length, scopes (pure)
//   withTypeHints the broken commits, each that fails the pattern on a type main already uses with a hint
//                 naming that type and the pattern widened to take it
//
// `exec report`, the merge (preflight and land), the rebase brief and `board commits --learn` are the
// readers; the rules are checked at load by `process/spec/workflow.mjs`, so a pattern here always compiles.
import { own } from "../process/spec/shape.mjs";
import { git } from "./worktree.mjs";

/** The spec's `commits` rules, or null when the workflow file sets none. */
export const rulesOf = (spec) => own(spec, "commits") ?? null;

const NO_MATCH = "subject does not match commits.subjectPattern";

// The subject: the message's first line, a trailing carriage return dropped.
const firstLine = (text) =>
  String(text ?? "")
    .split("\n", 1)[0]
    .trim();
const subjectOf = (message) => message.split("\n", 1)[0].replace(/\r$/, "");

/** `commits` as `{ sha, message }`: the ones that break `rules` (`{ subjectMax?, subjectPattern?, forbid? }`)
 *  as `{ sha, subject, why }`, in order, with the first rule each breaks: the length, then the pattern,
 *  then each `forbid` pattern in turn. `subjectPattern` is compiled with no flags, `forbid` with `m`
 *  against the whole message. Pure. */
export function checkCommits(rules, commits) {
  const out = [];
  for (const { sha, message, failed } of commits) {
    if (failed !== undefined) {
      out.push({ sha, subject: "", why: failed });
      continue;
    }
    const subject = subjectOf(message);
    const chars = [...subject].length;
    let why = null;
    if (rules.subjectMax !== undefined && chars > rules.subjectMax)
      why = `subject is ${chars} chars (commits.subjectMax ${rules.subjectMax})`;
    else if (rules.subjectPattern !== undefined && !new RegExp(rules.subjectPattern).test(subject))
      why = NO_MATCH;
    else {
      const at = (rules.forbid ?? []).findIndex((re) => new RegExp(re, "m").test(message));
      if (at >= 0) why = `message matches commits.forbid[${at}]`;
    }
    if (why) out.push({ sha, subject, why });
  }
  return out;
}

// The entry that stands for a commit list git could not read: it breaks, so no one goes on past it.
const FAILED = "git show failed";

/** The messages of `shas` in `dir`, as `{ sha, message }` in the order given; `[]` for no `shas`. When
 *  git cannot say, one `{ sha, failed }` entry instead, naming the first sha whose read fails (each is read
 *  alone to find it) and the first line of git's error: `checkCommits` turns it into a broken commit, so a
 *  read that failed never passes as "no commit breaks a rule". */
export function readCommits(dir, shas) {
  if (shas.length === 0) return [];
  const show = (list) => git(dir, ["show", "-s", "--format=%H%x1f%B%x1e", ...list, "--"]);
  const res = show(shas);
  if (res.status !== 0) {
    const alone = shas.map((sha) => ({ sha, res: show([sha]) })).find((x) => x.res.status !== 0);
    const why = firstLine((alone?.res ?? res).stderr);
    return [{ sha: alone?.sha ?? "", message: "", failed: `${FAILED}: ${why}` }];
  }
  const byId = new Map();
  for (const record of res.stdout.split("\x1e")) {
    const [sha, message] = record.replace(/^\n/, "").split("\x1f");
    if (sha) byId.set(sha, (message ?? "").replace(/\n+$/, ""));
  }
  return shas.filter((sha) => byId.has(sha)).map((sha) => ({ sha, message: byId.get(sha) }));
}

/** The commits among `shas` (in `dir`) that break the spec's `commits` rules; `[]` with no rules. */
export function brokenIn(dir, spec, shas) {
  const rules = rulesOf(spec);
  return rules ? checkCommits(rules, readCommits(dir, shas)) : [];
}

// --- what the default branch's history says ------------------------------------------------------

/** The Conventional Commits types, in the order a learned pattern lists them. */
export const STANDARD_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
// How far back the history is read, and the longest subject a learned rule allows.
export const HISTORY = 500;
const MAX = 72;

/** A subject's leading type, the word before its `(` or `:` (a breaking `!` allowed before the `:`);
 *  null when it has none. */
export const typeOf = (subject) => /^([A-Za-z][\w-]*)(?=\(|!?:)/.exec(subject)?.[1] ?? null;

/** The subjects of `branch`'s last `HISTORY` first-parent commits in `dir`, newest first; `[]` when git
 *  cannot say (no such branch, no commit yet). */
export function historySubjects(dir, branch) {
  if (!branch || branch.startsWith("-")) return [];
  const res = git(dir, [
    "log",
    "--first-parent",
    `-n${HISTORY}`,
    "--format=%B%x1e",
    `refs/heads/${branch}`,
    "--",
  ]);
  if (res.status !== 0) return [];
  return res.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map(subjectOf);
}

/** How many of `subjects` lead with each type, as a Map. Pure. */
export function typeCounts(subjects) {
  const counts = new Map();
  for (const subject of subjects) {
    const type = typeOf(subject);
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/** A subject pattern taking `types`, a scope in parentheses (required when `scoped`), a breaking `!`. */
export const patternOf = (types, scoped) =>
  `^(${types.join("|")})${scoped ? "\\([^)]+\\)" : "(\\([^)]+\\))?"}!?: `;

/** The rules `subjects` (a branch's history, any order) keep: the standard types plus each other type
 *  used `min` times or more (most used first), each with its count; `scoped` when every subject of one of
 *  those types has a scope; `subjectMax` the smallest of 72 and the longest subject, rounded up to 72 when
 *  90 % of the subjects fit in 72. With no subjects, the standard set. Pure. */
export function learnRules(subjects, { min = 3 } = {}) {
  const counts = typeCounts(subjects);
  const extra = [...counts]
    .filter(([type, n]) => !STANDARD_TYPES.includes(type) && n >= min)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const types = [
    ...STANDARD_TYPES.map((type) => ({ type, count: counts.get(type) ?? 0, standard: true })),
    ...extra.map(([type, count]) => ({ type, count, standard: false })),
  ];
  const names = new Set(types.map((t) => t.type));
  const typed = subjects.filter((s) => names.has(typeOf(s)));
  const scoped = typed.length > 0 && typed.every((s) => s[typeOf(s).length] === "(");
  const lengths = subjects.map((s) => [...s].length);
  const fit = lengths.filter((n) => n <= MAX).length;
  const subjectMax =
    lengths.length === 0 || fit >= 0.9 * lengths.length ? MAX : Math.min(MAX, Math.max(...lengths));
  return { types, subjectPattern: patternOf([...names], scoped), subjectMax, scoped };
}

// The first group of `pattern` that lists plain words as alternatives (`(feat|fix)`, `(?:a|b)`).
const TYPE_GROUP = /(?<!\\)\((\?:)?([A-Za-z][\w-]*(?:\|[A-Za-z][\w-]*)+)\)/;

/** `pattern` taking `type` too: added to its first group of alternative words, else as an alternative
 *  of the whole pattern (`(?:<pattern>)|^type…`). */
export function withType(pattern, type) {
  const group = TYPE_GROUP.exec(pattern);
  if (!group) return `(?:${pattern})|${patternOf([type], false)}`;
  if (group[2].split("|").includes(type)) return pattern;
  const at = group.index + group[0].length - 1;
  return `${pattern.slice(0, at)}|${type}${pattern.slice(at)}`;
}

/** `broken` (`checkCommits`' answer) with a `hint` on each commit that fails `subjectPattern` on a type
 *  `main`'s history uses (N >= 1 times) and that the pattern widened to that type would take: the type,
 *  its count and the widened pattern as a JSON string, ready to paste. Others get `hint: null`. Main's
 *  history is read only when some commit fails the pattern. */
export function withTypeHints(dir, main, rules, broken) {
  if (!broken.some((c) => c.why === NO_MATCH)) return broken.map((c) => ({ ...c, hint: null }));
  const counts = typeCounts(historySubjects(dir, main));
  return broken.map((c) => {
    const type = c.why === NO_MATCH ? typeOf(c.subject) : null;
    const n = (type && counts.get(type)) ?? 0;
    const widened = n > 0 ? withType(rules.subjectPattern, type) : null;
    const takes = widened !== null && new RegExp(widened).test(c.subject);
    const hint = takes
      ? `type "${type}" is used ${n} time${n === 1 ? "" : "s"} on ${main}: add it to commits.subjectPattern? ${JSON.stringify(widened)}`
      : null;
    return { ...c, hint };
  });
}
