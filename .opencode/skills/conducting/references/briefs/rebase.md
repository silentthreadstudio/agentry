# Rebase {{id}}, round {{round}}

You are the builder for contract {{id}} ({{contract}}). The lane is verified, but `{{branch}}` no longer lands
cleanly on `{{mainBranch}}`: rebase it, and do nothing else.

{{#resend}}
## Sent back
Your last report ({{from}}) was not readable: {{reason}}. Send it again, fixed, as the Report section below
asks. Change nothing else.

{{/resend}}
{{#guard}}
## Refused report

The lane refused your last report ({{from}}): {{reason}}. Fix exactly that, then report again.

{{/guard}}
## Where you work

- Worktree: {{worktree}}, on branch `{{branch}}` at {{tip}}, cut from {{base}}. Work only there.
- Prefix every shell command with `{{cd}} &&`, and give every file you read or edit as an absolute
  path under the worktree. Never change the main checkout at {{mainRoot}}: the lane stops when its HEAD or
  its files change.
- Logs and scratch files go only under {{logDir}}.

## The rebase

1. `{{cd}} && git rebase {{mainBranch}}` (no `-i`).
2. At each conflict keep both sides' intent: what `{{mainBranch}}` changed and what this branch changed. Resolve
   only the conflicted hunks, then `git add` them and `git rebase --continue`.
3. Change nothing else: no new feature, no clean-up, no reworded commit{{rewordExcept}}, no extra commit. A conflict you
   cannot settle without a decision is `BLOCKED`, naming the files and both sides.
4. Finish the rebase: no rebase left in progress, no uncommitted or untracked files. Do not merge or push.
   The gate is the lane's: it runs on the new tip after you report.

The contract, for what this branch's side means:

{{block}}

{{#reword}}
## Reword

The land refuses these commits: each breaks the workflow file's `commits` rules. Reword each one as you
rebase, its message only (its change stays as it is), so it keeps every rule: `git commit --amend` for the
tip, or a rebase with `exec` for one before it, no `-i`.

{{rewordLines}}

{{/reword}}
{{#policy}}
## Repo policy (overrides the contract where they differ)

{{policyLines}}

{{/policy}}
## Report

Write your full report to {{reportPath}} and reply with the same text. Its first line is one of `DONE`,
`DONE_WITH_CONCERNS`, `BLOCKED`, followed by one line saying what you did. Then each conflicted file and how
you resolved it, the new tip, and a `used_memories:` line (ids, or `none`).
