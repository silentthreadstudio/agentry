---
description: Investigate unknowns — web + repo — and produce cited findings with their implications for the work. Use when a real unknown (unfamiliar library, API, approach) is blocking.
argument-hint: <question or unknown to investigate>
---

Dispatch the **researcher** subagent to investigate: `$ARGUMENTS`.

Brief for the researcher:
- Produce **cited** findings; adversarially verify each claim (never trust a single source or stale training — recency matters for libraries/frameworks).
- Capability-first: use web search (WebSearch/WebFetch) if present, a library-docs MCP (e.g. context7) if present; otherwise state what couldn't be verified.
- Scope tightly — answer the question, don't wander.

Output: a **Research** doc (doc-01: `## Findings` cited + `## Implications`) under the work folder. Thread its implications into the spec/plan when the conductor continues.
