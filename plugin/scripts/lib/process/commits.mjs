// commits — what the default branch's history says about its commit subjects: the Conventional Commits
// types, a subject's type, the subjects of a branch's last `HISTORY` first-parent commits (read through
// `git.mjs`), and the `commits` rules such a history keeps. `board commits --learn` prints the rules; the
// lanes' `subjects.mjs` widens a pattern with the types main already uses.
//
//   subjectOf        a message's subject: its first line, a trailing carriage return dropped (pure)
//   typeOf           a subject's leading type, or null (pure)
//   historySubjects  the subjects of a branch's last HISTORY first-parent commits, newest first
//   typeCounts       how many subjects lead with each type (pure)
//   patternOf        a subject pattern taking some types (pure)
//   learnRules       the rules a history of subjects keeps: its types, length and scopes (pure)
import { runGit } from "./git.mjs";

/** A message's subject: its first line, a trailing carriage return dropped. */
export const subjectOf = (message) => message.split("\n", 1)[0].replace(/\r$/, "");

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
  const res = runGit(dir, [
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
