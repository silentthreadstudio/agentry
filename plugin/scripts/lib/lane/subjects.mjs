// subjects — the workflow file's `commits` rules applied to commit messages: a subject longer than
// `subjectMax` (code points), one `subjectPattern` does not match, a message a `forbid` pattern matches.
//
//   checkCommits  rules + commits → the commits that break one, with the first rule broken (pure)
//   readCommits   the messages of commits in a repo, oldest first as given
//   brokenIn      the two together: the commits among `shas` that break the spec's rules
//
// `exec report` and the merge (preflight and land) are the readers; the rules are checked at load by
// `process/spec/workflow.mjs`, so a pattern here always compiles.
import { own } from "../process/spec/shape.mjs";
import { git } from "./worktree.mjs";

/** The spec's `commits` rules, or null when the workflow file sets none. */
export const rulesOf = (spec) => own(spec, "commits") ?? null;

// The subject: the message's first line, a trailing carriage return dropped.
const subjectOf = (message) => message.split("\n", 1)[0].replace(/\r$/, "");

/** `commits` as `{ sha, message }`: the ones that break `rules` (`{ subjectMax?, subjectPattern?, forbid? }`)
 *  as `{ sha, subject, why }`, in order, with the first rule each breaks: the length, then the pattern,
 *  then each `forbid` pattern in turn. `subjectPattern` is compiled with no flags, `forbid` with `m`
 *  against the whole message. Pure. */
export function checkCommits(rules, commits) {
  const out = [];
  for (const { sha, message } of commits) {
    const subject = subjectOf(message);
    const chars = [...subject].length;
    let why = null;
    if (rules.subjectMax !== undefined && chars > rules.subjectMax)
      why = `subject is ${chars} chars (commits.subjectMax ${rules.subjectMax})`;
    else if (rules.subjectPattern !== undefined && !new RegExp(rules.subjectPattern).test(subject))
      why = "subject does not match commits.subjectPattern";
    else {
      const at = (rules.forbid ?? []).findIndex((re) => new RegExp(re, "m").test(message));
      if (at >= 0) why = `message matches commits.forbid[${at}]`;
    }
    if (why) out.push({ sha, subject, why });
  }
  return out;
}

/** The messages of `shas` in `dir`, as `{ sha, message }` in the order given; `[]` when git cannot say. */
export function readCommits(dir, shas) {
  if (shas.length === 0) return [];
  const res = git(dir, ["show", "-s", "--format=%H%x1f%B%x1e", ...shas, "--"]);
  if (res.status !== 0) return [];
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
