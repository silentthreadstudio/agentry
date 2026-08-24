---
description: Open the Agentry Workbench — the Agent Center. Focuses the running server (or starts it, once), registers this project with it, and opens the deep link. Pass a work id to jump straight into that run; omit it for the board.
argument-hint: "[work] — a run/work id to open (optional; omit for the board)"
---

Open the **Agentry Workbench** for this project. `$ARGUMENTS` is the optional `[work]` — a run/work id to deep-link into; when empty, open the **board** — every piece of work in this project, from intent to shipped.

This command is **focus-or-start**: the fixed port `:4317` is the singleton lock, so there is **exactly one** Workbench server per machine. Probe first; only start if nothing is up; a second invocation always *focuses* the running one and never spawns a second server.

**One server, many projects.** The port is global but a project root is not, so the running server may have been started from *another* repo. Do **not** assume it is serving this one: **register this project with it** (`POST /api/projects`) and open the deep link scoped to the returned slug. Registration is idempotent and the server persists it, so every repo you open the Workbench from stays available in the sidebar's project switcher.

Execute these steps with the platform's shell/`open` affordances:

## 1. Resolve the target

- **Project root** = the current project directory (the repo root that holds `.agentry/`).
- Run identity travels in the **path**, not the hostname — `*.localhost` subdomains are a back-compat alias only (they 302 to the path form). Never build a `<run>.localhost` URL: browsers lower-case the `Host` header, so a run id with an uppercase character silently resolves to no run.
- **Deep link** (after step 3 gives you `<slug>`):
  - `$ARGUMENTS` given ⇒ `http://localhost:4317/work/<work>?project=<slug>`
  - `$ARGUMENTS` empty ⇒ `http://localhost:4317/?project=<slug>`

## 2. Probe `/healthz` (is one already up?)

```bash
curl -fsS -m 2 http://127.0.0.1:4317/healthz
```

- **Exit 0 (up)** ⇒ go to step 3 (**register + focus**).
- **Non-zero / connection refused (down)** ⇒ go to step 4 (**start**), then step 3.

A successful probe means the server is already running — the port bind held by that process *is* the lock. Do **not** spawn another.

## 3. Register this project, then open

Tell the running server about this repo and take the slug it returns:

```bash
curl -fsS -X POST -H 'content-type: application/json' \
  -d "{\"root\":\"<projectRoot>\"}" http://127.0.0.1:4317/api/projects
# → {"slug":"<slug>","root":"<projectRoot>"}
```

Then open the deep link from step 1:

```bash
open "<deep-link>"          # macOS; use xdg-open on Linux, start on Windows
```

Registration is what makes a second (third, fourth) repo work: without it the server would still answer, but from whichever project it was started in — the silent cross-project contamination this step exists to prevent. If the POST fails (an older server predating multi-project support), say so and report which project it *is* serving — `curl -fsS http://127.0.0.1:4317/api/context` returns `{ project, root }` — so the user can decide whether to restart it here.

## 4. Down ⇒ start (detached spawn, poll, then register+open)

Spawn the **committed server artifact** detached, so it outlives this command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/workbench/server/index.js"
```

Start it detached/backgrounded (e.g. `nohup … &`) so the Workbench keeps running after the command returns. The server binds `:4317` (the singleton lock), registers the root it was started from as the **default** project, and writes its pidfile at `<projectRoot>/.agentry/run/workbench.json` — **this command does not write the pidfile**.

Then **poll `/healthz` until ready**, with a timeout (the server needs a moment to bind):

```bash
for i in $(seq 1 20); do
  curl -fsS -m 1 http://127.0.0.1:4317/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
```

- **Became ready** ⇒ continue at step 3 (register + open).
- **Timed out** (never healthy) ⇒ report the failure — do not open a dead URL. Surface the server's startup output if captured (e.g. the `nohup` log) so the user can see why it didn't bind (an `EADDRINUSE` here means a race lost to another starter that *is* now up — re-probe once and continue at step 3).

## Notes

- **Never two servers.** The bind is the lock: if two invocations race, exactly one wins; the loser's probe (or its `EADDRINUSE`) sends it down the focus path.
- **Diagnostics.** The running instance's metadata is in the pidfile at `<projectRoot>/.agentry/run/workbench.json` — `{ pid, port, startedAt }` (advisory; the port bind, not this file, is the lock). `GET /api/projects` lists every project the server currently serves.
- **Reload-gated:** command changes register only on plugin reload/restart.
