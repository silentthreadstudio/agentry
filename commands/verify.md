---
description: Adversarially verify a task against its acceptance — two ordered passes (spec-compliance then code-quality) with a security lens and cited evidence. A separate verifier, never the author.
argument-hint: <task id>
---

Dispatch the **verifier** subagent to verify task `$ARGUMENTS`. It must be a *different* context than the implementer — no self-grading.

Brief for the verifier:
- **Two ordered passes:** (1) spec-compliance, then (2) code-quality only if compliance passes.
- Apply the **security lens** (injection, authz/authn, secrets, path traversal, unsafe deserialization, SSRF).
- **Cite evidence/method** for every verdict — test counts, a command run, a trace, a screenshot path. **No bare PASS.** Use a browser MCP to verify UI behavior if present.
- Name any gotcha discovered.

Output: a **Verdict** (doc-01 Review): per-AC PASS/FAIL/UNVERIFIED + cited evidence + named gotchas.

After the verdict: the conductor harvests any named gotcha to memory (the verifier stays read-only). On needs-changes touching a shared seam, pause and re-thread the not-yet-started tasks on that seam.
