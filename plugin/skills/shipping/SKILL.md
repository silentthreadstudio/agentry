---
name: shipping
description: This skill should be used when running the last mile of a change — branching, committing, opening a PR, watching CI, responding to review, and merging — and especially when an action leaves the machine (push / PR-open / merge). It carries the authorization boundary (local actions proceed unattended; outward actions are gated, per-action, discovered at runtime, defaulting to gate) and the ship playbook. Loaded for delivering work to a shared remote, not for building or verifying it.
version: 0.1.0
---

# Shipping

Take a verified change the last mile — **branch → commit → PR → CI → review → merge** — without ever letting an autonomous default *leave the machine*. The whole craft turns on one classification: **every ship step is `local` or `outward`.** Local work proceeds unattended; outward work passes a gate the **conductor** owns. This skill *tags* each step; the conductor *evaluates* the gate. That seam is the safety property — keep it.

## The boundary — `local` vs `outward`

Classify **every** ship action before performing it:

- **`local`** — reversible, never leaves the machine: create a branch, stage, commit, write the PR body **to a file**, run/watch CI, apply a fix. A bad one is one command away from undone. **Local actions proceed unattended** in every mode.
- **`outward`** — published, hard to reverse: it reaches a shared remote, notifies humans, or mutates a protected branch. The outward set is exactly three actions: **`push`, `pr-open`, `merge`.** Each one passes an `authorize(action)` checkpoint **before** it runs.

> **The skill tags; the conductor gates.** A specialist never authorizes its own outward action — `authorize(action)` is evaluated by the conductor (the main session, the only surface that can converse and gate), exactly like the spec/plan gates. If you are not the conductor, you tag the step `outward` and **hand it up**; you do not perform it.

## The per-action authorization policy — discovered, defaulting to `gate`

Each outward action carries a policy ∈ `{gate, auto}`:

- **`gate`** — a **human** must authorize before the action runs.
- **`auto`** — pre-authorized; the action proceeds without a prompt (the operator owns that choice).

**The policy is discovered at runtime, never shipped.** Read an `<authorization-policy>` for `{push, pr-open, merge}` from the **same runtime sources every other repo convention is discovered from** — the repo's `CLAUDE.md`, memory, or a repo settings file. **When nothing is found, all three default to `gate`** — the safe default. Do **not** invent or ship a bespoke config file for this; discover the policy the way `<branch-naming>` and `<co-author-trailer>` are discovered. A repo may set, e.g., `push: auto` while leaving `merge: gate`.

The discovery recipe for `<authorization-policy>` (and every other placeholder) lives in `references/last-mile.md`.

### The Workbench channel grant — the human authorization at the gate

An outward action stays `outward` and stays gated regardless of channel — a Workbench permission **grant** does not change the classification or invent a new gate. It is simply **how a human clears `authorize(action)`** from the Workbench: a channel permission grant for `push` / `pr-open` / `merge` *is* the human authorization that a `gate` policy requires, relayed in. It satisfies the same gate the conductor already owns — no grant, no outward action; a grant authorizes only the specific action it names, nothing more. This is the local-autonomous / outward-gated boundary unchanged, with the grant as one channel for the human's "yes."

## Composition with the two conductor modes

The policy (`gate`/`auto`) is a **second axis, orthogonal to the conductor's interaction mode** (`interactive`/`auto-pilot`). Mode changes *who can clear a gate*; it never downgrades a `gate` to an `auto`. The four combinations:

| | **policy: `gate`** | **policy: `auto`** |
| :--- | :--- | :--- |
| **interactive** | **stop and ask** the user before the action | **proceed** unprompted (pre-authorized via the policy) |
| **auto-pilot** | **record-and-stop:** write the decision artifact, surface the pending outward action, **HALT at the boundary** — never auto-perform | **proceed** (explicitly pre-authorized) |

The rule in one line: **`gate` means a human must authorize; auto-pilot cannot satisfy `gate` by itself — it records and stops at the boundary.** Auto-pilot removes the human-*wait* on `auto` actions; it does **not** remove the gated *work*.

### auto-pilot + `gate` ⇒ record-and-stop (the load-bearing case)

This is the highest-stakes path — a headless/autonomous run reaching an outward action that is still `gate`. The discipline is **record, surface, halt** — and it is the conductor's:

1. **Complete all `local` work autonomously** — branch, commit, write the PR body to a file, watch CI — up to the boundary.
2. **Record the decision artifact** — what the action would be, why, and a one-line override hint (how a human clears it), in the run's decision artifact (the conductor's auto-pilot record format).
3. **Surface the pending outward action** — name the staged, described action explicitly so a human can see exactly what is waiting.
4. **HALT the ship loop at that boundary.** Do **not** push, open the PR, or merge. Auto-pilot **records-and-stops; it never auto-performs a gated outward action.**

A headless run with `merge: gate` therefore reaches **"PR open / awaiting authorization,"** surfaces it, and stops. That ceiling is the intended design, not a defect.

## "Done = merged + green" — only via an authorized merge

The merge is an **outward, gated action**, and `merge` defaults to `gate`. **"Green" is a *precondition* for offering the merge, never an authorization to perform it.** So "done = merged + green" is reached **only through an authorized merge** — the autonomous default never merges. (What "green" means — the two-tier required-checks-then-all-reported determination — is in `references/last-mile.md`.)

## The last-mile playbook (skeleton)

Each step is tagged `local` or `outward`. Outward steps pass `authorize(action)` first.

1. **Branch** *(local)* — create a working branch named per the repo's `<branch-naming>` convention (discovered).
2. **Commit** *(local)* — stage and commit with a good message in the repo's `<commit-style>`, appending the repo's `<co-author-trailer>` (both discovered).
3. **Write the PR body** *(local)* — derive it from the spec/plan and write it **to a file** (a local artifact; nothing has left the machine yet).
4. **`authorize(push)` → Push** *(**outward**)* — gate on the `push` policy, then push the branch via the repo's `<vcs-cli>`.
5. **`authorize(pr-open)` → Open PR** *(**outward**)* — gate on the `pr-open` policy, then open the PR from the body file using `<vcs-cli>` / the repo's `<pr-template>`.
6. **Watch CI** *(local)* — poll the repo's `<ci-provider>` through `<vcs-cli>` until checks settle; determine "green" by the two-tier rule (and record which tier).
7. **If CI is red → re-enter the fix discipline** *(local)* — route back as `kind=ci-red` (the `implementing` "When fixing" mode: reproduce-first → fix → regression-guard). Never merge on red.
8. **Respond to review threads** *(local)* — address each thread; push follow-up commits (each a fresh `authorize(push)` gate) as needed.
9. **`authorize(merge)` → Merge** *(**outward**)* — gate on the `merge` policy; merge **only** when green (by the recorded tier) and authorized. This is the only path to "done = merged + green."

The **how** of every discovery and each step — the placeholder recipes, CI poll-vs-block, the two-tier green determination, PR-body-from-spec/plan derivation, and review-thread response — lives in the reference.

## Anti-patterns (refuse these)

- **Performing an outward action yourself** — a specialist (or the skill) authorizing its own `push`/`pr-open`/`merge`. Tag it `outward` and hand the gate to the conductor.
- **Auto-pilot auto-performing a gated action** — "recording it" is necessary but **not sufficient**; `gate` needs a human. Record-and-stop, never proceed-and-log.
- **Treating "green" as authorization to merge** — green is a precondition; merge still passes the gate.
- **Shipping a bespoke config file** — invent no `ship.config`; the policy is discovered like every other convention, defaulting to `gate`.
- **Merging on red** — CI-red re-enters the fix discipline; it never merges.
- **Baking a tool in** — a hardcoded VCS CLI, CI provider, branch convention, or trailer. Every concrete value is a placeholder discovered at runtime.

## Additional resources

### Reference files
- **`references/last-mile.md`** — the deep mechanics: the generic discovery recipes for every placeholder (`<vcs-cli>`, `<ci-provider>`, `<pr-template>`, `<branch-naming>`, `<commit-style>`, `<co-author-trailer>`, `<authorization-policy>`), CI poll-vs-block, the two-tier "green" determination and recording the tier, PR-body-from-spec/plan derivation, and review-thread response.
