# Comprehension Techniques — depth

Reference for the `exploring` skill. Techniques serve one end: **a faithful map at the lowest reading cost** — understand the repo well enough for the next specialist to act, without reading the world. Apply the depth the ask earns, never more.

## Finding entry points

Execution starts somewhere; entry points are the threads you pull to understand everything downstream. Find them before reading bodies.

- **Declared entry** — manifest fields: `main`/`bin`/`scripts` (package.json), `[project.scripts]`/`__main__` (Python), `func main` (Go), `[[bin]]` (Cargo), a `Procfile`/`Dockerfile CMD`.
- **Framework entry** — route/handler registration (web), command definitions (CLI), event/job subscribers, exported public API of a library.
- **Test entry** — test files double as usage examples; the test of a module shows its contract from the caller's side, fast.

From an entry point, follow the *call direction* outward. The set of reachable code from the relevant entry is your scope; everything unreachable from it is probably noise for this ask.

## Tracing dependency and data flow

The dependency graph *is* the architecture; trace it rather than guessing.

- **Outward (what this uses)** — read the imports/`use`/`require` at the top of a file: its dependencies, at a glance, without reading bodies.
- **Inward (what uses this)** — find-references / call-hierarchy on a symbol shows every caller. This is where a semantic code-intel tool (Serena / LSP) crushes text search: precise, type-aware, no false hits from comments or strings.
- **Data flow** — pick the value that matters (a request, a token, a record) and follow it: where it's created → transformed → persisted → returned. Trace the *value*, not every function it passes through.
- **Dependency direction** — note which way arrows point. Stable core ← volatile edges is healthy; core importing the edge is an inversion worth flagging (read-only: report, don't fix).

Stop at the boundary of the ask. "Where does auth validate" ends at the validation site — not three libraries down.

## Inferring conventions

Repo-consistency downstream depends on naming the rules already in force. Read a representative few files, not all:

- **Naming & layout** — file/dir naming, how features are grouped (by-layer vs by-feature), where types/interfaces live.
- **Layering** — is there a controller/service/repository split? A domain core? Where does I/O sit?
- **Error handling** — exceptions vs result types vs error returns; where errors are caught and shaped.
- **Tests** — colocated vs separate tree, framework, naming, what's mocked at the seams.
- **Config & secrets** — env vars, config files, how the app is wired at startup.

Two files agreeing is a pattern; one file is an instance. State conventions you can see repeated, flag the rest as uncertain.

## Stack profiling cheat-sheet

Profile the environment first — it tells you how to read everything else and is repo-fact the team needs.

| Stack | Manifest | Lock | Package mgr (hint) | Run/test |
| :--- | :--- | :--- | :--- | :--- |
| Node/TS | `package.json` | `pnpm-lock` / `yarn.lock` / `package-lock` | the lockfile names it | `scripts` block |
| Python | `pyproject.toml` / `setup.py` | `poetry.lock` / `uv.lock` | the lockfile names it | `[tool.*]`, `tox`, `pytest` |
| Go | `go.mod` | `go.sum` | go modules | `go test ./...`, `Makefile` |
| Rust | `Cargo.toml` | `Cargo.lock` | cargo | `cargo test`, `cargo run` |
| JVM | `pom.xml` / `build.gradle` | — | maven / gradle | the build file's tasks |

Always also read CI (`.github/workflows`, `Makefile`, `Justfile`) — it states the *real* build/test/run commands the project actually uses, ground-truth over guessing. And note which code-intel tools are present (Serena / LSP) — prefer them; record their availability as a repo-fact.

## The Context map template

Distill everything read into this shape (doc-01 — `.agentry/context.md`). Coordinates + structure + the few load-bearing facts:

```markdown
## Stack / environment   — language(s), package manager, framework, build/test/run commands, code-intel tools available
## Structure             — the major parts + where things live (dir → responsibility), one line each
## Key flows             — the 1–3 flows that matter, as paths: entry → hops → the place that matters
## Conventions           — naming, layering, error handling, test layout, config — the rules in force
## Entry points          — mains / handlers / public API — where execution starts
## Open / external       — unknowns flagged for the researcher; areas left unmapped (out of scope)
```

## Distill, don't dump — a worked example

**Dump (wrong)** — pasting contents, no structure:

> Here is `auth/middleware.ts` (84 lines): `import {...} ... export function requireSession(req) { const t = req.headers... }` … [and the full text of six more files]

**Map (right)** — coordinates + the load-bearing fact:

> **Auth flow:** request enters at `api/server.ts` (entry) → `auth/middleware.ts::requireSession` reads the bearer token → validates via `auth/tokens.ts::verify` (HS256, secret from `JWT_SECRET`) → attaches `Session` to `req`, or 401s. **Convention:** all protected routes go through `requireSession`; tokens are never validated inline. **Gotcha to verify:** `verify` swallows expiry errors as generic 401 (`auth/tokens.ts:41`).

The map is shorter, says where, and carries the one fact the next specialist needs. That is the craft.
