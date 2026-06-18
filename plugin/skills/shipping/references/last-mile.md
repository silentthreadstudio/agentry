# Last-mile mechanics — depth

Reference for the `shipping` skill. The skeleton (the nine-step playbook, the `local`/`outward` boundary, the policy map, mode composition) lives in `SKILL.md`. This file is the **how**: how each convention is discovered generically, how CI is watched, how "green" is determined, how the PR body is derived, and how review threads are answered. **Every concrete value here is a placeholder discovered at runtime** — the shipped asset bakes in no tool, provider, branch convention, or trailer.

## The discovery principle

The ship loop is **generic**. It hardcodes nothing repo-specific; it **discovers** every convention from the runtime sources the rest of Agentry already uses, in priority order:

1. The repo's `CLAUDE.md` / contributing guide / repo settings file.
2. Durable **memory** (recalled repo-facts for this repo).
3. The repo itself — its existing history, config, and templates (read, infer, confirm).

If a convention can't be found, fall back to the safe generic default named below for that placeholder (and for `<authorization-policy>`, the safe default is `gate` on all three actions). **Surface what you discovered** so the conductor can confirm it and seed it to memory for next time.

### The placeholders (discover each; never assume)

| Placeholder | What it is | Generic discovery recipe | Fallback when unfound |
| :--- | :--- | :--- | :--- |
| `<vcs-cli>` | the CLI that talks to the remote (push, open PR, read checks/protection) | check repo docs/memory for the named tool; else detect which remote CLI is installed and authenticated for this remote | the plain version-control CLI for `push`; surface that PR-open/checks may be unavailable |
| `<ci-provider>` | where checks run and report | infer from the remote host / repo config / docs; read its status **through `<vcs-cli>`**, never via a provider API | "checks as reported by `<vcs-cli>`," provider-agnostic |
| `<pr-template>` | the repo's PR description structure | look for the repo's PR template file / docs; match its sections | a plain summary + context + testing-notes body |
| `<branch-naming>` | the branch-name convention | read repo docs/memory; else infer the dominant pattern from recent branch history | a descriptive slug derived from the task/spec id |
| `<commit-style>` | the commit-message convention | read repo docs/memory; else infer from recent commit history | a concise imperative subject + a body explaining *why* |
| `<co-author-trailer>` | the trailer (if any) the repo appends to commits | **discover from the repo's `CLAUDE.md` / contributing guide / memory** | none — append a trailer **only** if the repo defines one; never invent one |
| `<authorization-policy>` | the per-action `{push, pr-open, merge}` → `{gate, auto}` map | read from `CLAUDE.md` / memory / a repo settings file (same sources as above) | **`gate` for all three** — the safe default AC9 demands |

> **The genericity rule (non-negotiable).** No example in this skill names a concrete CLI, CI provider, branch convention, or trailer string. If you need to *show* a value, show the **placeholder**. A repo supplies the real values at runtime; the shipped asset only knows how to *discover* them.

## Authorization, in the flow

Before each of the three outward actions, the conductor evaluates the gate (see `SKILL.md` for the full mode-composition table). The discipline here is just the ordering:

- **Resolve the policy first.** Look up the action in `<authorization-policy>` (default `gate`).
- **`auto`** → proceed with the action.
- **`gate`, interactive** → stop and ask the user; proceed only on a human's yes.
- **`gate`, auto-pilot** → **record-and-stop:** write the decision artifact (action + rationale + override hint), surface the pending action, and **halt**. Do not perform it. Auto-pilot completes all `local` work and leaves the outward action staged and described.

Each action is gated **independently** — a repo with `push: auto, merge: gate` pushes unprompted but still stops before the merge.

## CI watch — poll, don't integrate

v2 **watches** CI through the discovered CLI; it builds **no provider adapter, webhook, or dashboard**.

- **Read status by shelling out to `<vcs-cli>` and polling.** Ask the CLI for the current branch/PR check status; re-poll on an interval until the checks **settle** (every check has a terminal result) or a sane timeout is hit.
- **Poll vs. block.** In an **interactive** run you may block-and-poll until checks settle (the user is present). In an **auto-pilot / headless** run, prefer **poll-with-timeout**: if checks haven't settled by the bound, **record the in-flight state and stop at the next outward boundary** rather than hang — checks-still-running is itself a surfaced state, not a failure.
- Watching CI is a **`local`** step — it reads status; it publishes nothing.

## "Green" — the two-tier determination (and record the tier)

"Green" is the merge precondition, and it is **repo-specific**. Determine it in two tiers, both via `<vcs-cli>`:

1. **Tier 1 — required checks (preferred).** Attempt to read the **branch-protection required-check set** for the target branch through `<vcs-cli>`. If readable, **green = every *required* check has a success status.** This matches the repo's own merge bar.
2. **Tier 2 — fallback (all reported).** If the required set can't be read (no protection, insufficient permission, or the CLI doesn't expose it), **green = every *reported* check is passing.**

**Record which tier was used** in the run artifact, so the merge gate's basis is observable — never a silent downgrade. Tier 2 is slightly stricter than Tier 1 (it can block on a non-required check), never less safe.

If CI is **red**, **re-enter the fix discipline** (`kind=ci-red`: reproduce the failing check, fix at the cause, leave the regression guard) — **never merge on red.** "Green" gates *offering* the merge; it is never authorization to merge autonomously (that is always the `merge` gate).

## PR body — derive from the spec/plan

The PR body is a **`local`** artifact: derive it and write it **to a file** before anything is pushed.

- **Source of truth is the work itself** — the run's `spec.md` (intent + acceptance criteria) and `plan.md` (approach, ADRs). Summarize *what changed and why* from them; do not reinvent a narrative.
- **Shape it to `<pr-template>`** — fill the repo's template sections (e.g. summary, context/rationale, testing notes, linked issues) from the spec/plan. If no template is discovered, use a plain summary + context + testing-notes body.
- **Link the acceptance criteria** so a reviewer can check the PR against the same observable bar the work was built to.
- Write it to a file (don't construct it inline at push time) so it is reviewable as a local artifact and reusable if the push is re-gated.

## Review-thread response

After the PR is open, responding to review is a **`local`** loop (the follow-up *push* is the outward part, re-gated each time):

- **Read each thread; classify it** — a requested change, a question, or a suggestion.
- **For a requested change** — make the smallest correct edit, commit it (same `<commit-style>` + `<co-author-trailer>`), and re-enter the loop. The follow-up push is a fresh **`authorize(push)`** gate (outward).
- **For a question** — answer in the thread; no code change unless the answer reveals one.
- **Resolve threads as they're addressed** so the remaining review surface is always the open set.
- **If a review reveals a real failure**, treat it like CI-red: re-enter the fix discipline rather than patching the symptom in the thread.
- The **merge** still waits on its own `authorize(merge)` gate and green — review approval is necessary, not the authorization to merge.
