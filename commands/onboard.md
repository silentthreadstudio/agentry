---
description: Comprehend a repository read-only — produce a Context map (how it's built, where things live, key conventions) and seed durable repo-facts. Warms a cold codebase.
argument-hint: [area or focus — optional]
---

Dispatch the **explorer** subagent to comprehend this repository, read-only. If `$ARGUMENTS` is given, focus there; otherwise map the whole repo.

Brief for the explorer:
- Map how the repo is built, where things live, and its key conventions; trace entry points and the primary data/dependency flows.
- Prefer a semantic code-intel tool (Serena/LSP) if present; fall back to grep/glob/read. **Distill — do not dump files.**
- Detect the available tools/MCPs in this environment and record them.

Output: a **Context map** (doc-01 format) at `.agentry/context.md`, plus seeded `repo-fact` memories (including the available-capabilities profile). Change nothing — this node is read-only.
