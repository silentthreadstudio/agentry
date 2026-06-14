---
name: reviewing
description: This skill should be used when verifying that work meets its acceptance criteria and is sound — checking a task or change against its spec, judging code quality, or applying a security lens (injection, authz/authn, secrets, path traversal, unsafe deserialization, SSRF). Loaded for adversarial, evidence-backed verification by someone other than the author — not for writing or fixing code.
version: 0.1.0
---

# Reviewing

Prove the work wrong. Verification is adversarial: assume it's broken until observed behavior shows otherwise. Two ordered passes — **spec-compliance first, then code-quality** — with a **security lens** carried through both. Never grade your own work. Never return a bare PASS.

## The one rule that makes a review trustworthy

**Every verdict cites a method.** A PASS or FAIL is worthless without the evidence behind it: the test count, the exact command run, the trace, the screenshot path, the observed behavior. "Looks correct" is not evidence. If you can't observe it, the verdict is **UNVERIFIED**, not PASS. This is the difference between verification and rubber-stamping.

## Two ordered passes

Run them in order. **Pass 2 only proceeds if Pass 1 passes** — a broken thing's code style does not matter yet.

### Pass 1 — spec-compliance (does it do what was asked?)

1. List the acceptance criteria — the task's `## Acceptance` and the Spec ACs it `satisfies`.
2. For each criterion, **observe the behavior that proves it**: run the test, run the command, drive the UI, inspect the output. Do not infer it from the diff.
3. FAIL the criterion the instant the behavior doesn't hold. A missed or untestable criterion is a FAIL.
4. Stop here and report if any compliance criterion fails — do not move to quality.

### Pass 2 — code-quality (is it sound?)

Only after compliance passes. Judge:
- **Cohesion & coupling** — one responsibility per module; no reaching across boundaries.
- **Anti-patterns** — god-file, premature abstraction, copy-paste of a business rule (knowledge DRY).
- **Correctness risks** — unhandled errors, missing edge cases, race conditions, resource leaks.
- **Test quality** — do the tests actually exercise the behavior, or are they vacuous / over-mocked?

Quality findings are **reported**, not gated on — unless a finding is itself a correctness risk, which becomes a FAIL.

## The security lens (carried through both passes)

Apply to every review, not just "security features" — input handling, auth, and I/O are security surfaces regardless of intent. Check:

- **Injection** — SQL/command/template/log injection from untrusted input; is input parameterized/escaped at the sink?
- **Authz / authn** — is every privileged path actually gated? Missing checks, IDOR (object access without ownership check), privilege escalation.
- **Secrets** — keys/tokens/passwords hardcoded, logged, or returned in responses/errors.
- **Path traversal** — user-controlled paths reaching the filesystem without normalization/confinement.
- **Unsafe deserialization** — untrusted data into a deserializer that can instantiate or execute.
- **SSRF** — user-controlled URLs/hosts driving server-side requests without an allowlist.

A security failure is a **FAIL** regardless of feature-completeness.

## Tools (capability-first)

- Run the suite → prefer the repo's own test runner / task command if present → fallback: invoke the framework directly.
- Verify a UI → a browser MCP (chrome-devtools / claude-in-chrome) to render and observe → else mark the criterion **UNVERIFIED**; never assume a UI works.
- Read code → prefer a semantic code-intel tool (Serena / LSP) if present → fallback: grep / glob / read.

## Anti-patterns (refuse these)

- **Self-grading** — reviewing work you authored. The whole value is independence.
- **Bare PASS** — a verdict with no cited method.
- **Rubber-stamping** — approving because it "looks right" or the author said done.
- **Diff-checking instead of behavior-checking** — reasoning over the patch rather than running the system.
- **Skipping the security lens** because it "isn't a security change."

## Output

A per-criterion verdict: each AC → `PASS` / `FAIL` / `UNVERIFIED`, **each with its method/evidence**, plus any **gotcha** discovered (named, so the conductor harvests it into memory — "this seam breaks when X"). Report any memory that shaped the review in `used_memories`.

## Additional resources

### Reference files
- **`references/verification-method.md`** — the evidence taxonomy (what counts as proof per criterion type), the security checklist with example signatures, and how to write a citable verdict line.
