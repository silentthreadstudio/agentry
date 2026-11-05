// exec/rewords — the commits of a lane whose subject is longer than the repo's limit
// (`commits.subjectMax`, else 72), and the line that rewords each one, for `exec report` to print and for
// the fix brief of a refused report to carry. The guard that refuses a subject is `subjects.mjs`' rules at
// `report`; this module only says how to fix what is over the limit, with or without those rules.
import { shellQuote } from "../../text/shell.mjs";
import { short } from "../fmt.mjs";
import { checkCommits, readCommits, subjectLimit } from "../subjects.mjs";
import { git } from "../worktree.mjs";

// How many commits are listed, then how many more there are.
const LISTED = 5;

/** The commits in `start..branch` (in `root`) whose subject is over the limit, oldest first, as
 *  `{ sha, subject, chars }`. `[]` when git cannot list the range: the commit rules' own guard says so. */
export function overLimit(root, spec, start, branch) {
  const listed = git(root, ["rev-list", "--reverse", `${start}..${branch}`, "--"]);
  if (listed.status !== 0) return [];
  const commits = readCommits(root, listed.stdout.split("\n").filter(Boolean));
  return checkCommits(
    { subjectMax: subjectLimit(spec) },
    commits.filter((c) => c.failed === undefined),
  ).map(({ sha, subject }) => ({ sha, subject, chars: [...subject].length }));
}

/** The line that rewords `sha`, run from anywhere: the branch's tip is amended in its worktree; any other
 *  commit is checked out, amended, and the commits after it replayed onto it (`rebase --onto`, no `-i`).
 *  The new subject is the one thing left to write. */
export function rewordLine({ worktree, branch, sha, tip, limit }) {
  const cd = `cd ${shellQuote(worktree)}`;
  const amend = `git commit --amend -m "<new subject, at most ${limit} characters>"`;
  return sha === tip
    ? `${cd} && ${amend}`
    : `${cd} && git checkout -q --detach ${sha} && ${amend} && git rebase --onto HEAD ${sha} ${branch}`;
}

/** What to print for the commits `over` (from `overLimit`) of the lane's `ledger` at `tip`: one line each,
 *  at most `LISTED`, then `+n`. "" when none is over. */
export function rewordsText(spec, ledger, tip, over) {
  const limit = subjectLimit(spec);
  const lines = over.slice(0, LISTED).map((c) => {
    const line = rewordLine({
      worktree: ledger.worktree,
      branch: ledger.branch,
      sha: c.sha,
      tip,
      limit,
    });
    return `commit ${short(c.sha)} "${c.subject}" is ${c.chars} chars, over the ${limit} limit → ${line}`;
  });
  if (over.length > LISTED) lines.push(`+${over.length - LISTED}`);
  return lines.join("\n");
}
