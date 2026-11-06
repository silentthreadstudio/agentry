// subjects — the workflow file's `commits` rules applied to commit messages: a subject longer than
// `subjectMax` (code points), one `subjectPattern` does not match, a message a `forbid` pattern matches.
//
//   checkCommits  rules + commits → the commits that break one, with the first rule broken (pure)
//   readCommits   the messages of commits in a repo, oldest first as given
//   brokenIn      the two together: the commits among `shas` that break the spec's rules
//   withTypeHints the broken commits, each that fails the pattern on a type main already uses with a hint
//                 naming that type and the pattern widened to take it
//   subjectLimit  the longest subject the briefs and `exec report` name: subjectMax, else 72
//
// `exec report`, the merge (preflight and land) and the rebase brief are the readers; the rules are checked
// at load by `process/spec/workflow.mjs`, so a pattern here always compiles. What main's history says (its
// subjects, their types, the rules they keep) is `process/commits.mjs`'s.
import { historySubjects, patternOf, subjectOf, typeCounts, typeOf } from "../process/commits.mjs";
import { own } from "../process/spec/shape.mjs";
import { git } from "./worktree.mjs";

/** The spec's `commits` rules, or null when the workflow file sets none. */
export const rulesOf = (spec) => own(spec, "commits") ?? null;

/** The longest commit subject (in code points) the briefs and `exec report` name: `commits.subjectMax`,
 *  else 72. */
export const subjectLimit = (spec) => rulesOf(spec)?.subjectMax ?? 72;

const NO_MATCH = "subject does not match commits.subjectPattern";

// The first line of git's error, trimmed.
const firstLine = (text) =>
  String(text ?? "")
    .split("\n", 1)[0]
    .trim();

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
