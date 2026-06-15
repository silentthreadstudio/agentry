---
id: "g:01J0R3TEACHER0000000000001"
type: decision
scope: global
why: "Established by the R3 teacher run; the follow-up reuses it (AC8 lesson-reuse signal)."
tags:
  - "agentry:no-console-log-in-source"
  - logging
confidence: 0.95
usefulness: 1
decay: 0
status: active
createdAt: "2026-06-14T00:00:00.000Z"
updatedAt: "2026-06-14T00:00:00.000Z"
---

This project forbids `console.log` in shipped source. All logging must go through the exported `log()` helper, which writes via `process.stdout.write(message + "\n")`. New modules that emit output must follow this convention.
