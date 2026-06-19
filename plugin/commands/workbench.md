---
description: Open the Agentry Workbench — the Agent Center. Focuses the running server (or starts it, once) and opens the deep link. Pass a work id to jump straight into that run; omit it for the Works home.
argument-hint: "[work] — a run/work id to open (optional; omit for the Works home)"
---

Open the **Agentry Workbench** for this project. `$ARGUMENTS` is the optional `[work]` — a run/work id to deep-link into; when empty, open the **Works home**.

This command is **focus-or-start** (ADR-002): the fixed port `:4317` is the singleton lock, so there is **exactly one** Workbench server per project. Probe first; only start if nothing is up; a second invocation always *focuses* the running one and never spawns a second server. The server (not this command) writes the pidfile.

Execute these steps with the platform's shell/`open` affordances:

## 1. Resolve the target

- **Project root** = the current project directory (the repo root that holds `.agentry/`).
- **Deep link**:
  - `$ARGUMENTS` given (a work id) ⇒ `http://<work>.localhost:4317` — note `*.localhost` auto-resolves to `127.0.0.1` (RFC 6761), no `/etc/hosts` edit.
  - `$ARGUMENTS` empty ⇒ bare `http://localhost:4317` — the **Works home** (no run context).

## 2. Probe `/healthz` (is one already up?)

Probe the **loopback** health endpoint directly — `http://127.0.0.1:4317/healthz` — **not** a `*.localhost` host (a CLI probe shouldn't depend on subdomain resolution; the health probe is loopback by design, ADR-002). For example:

```bash
curl -fsS -m 2 http://127.0.0.1:4317/healthz
```

- **Exit 0 (up)** ⇒ go to step 3 (**focus**).
- **Non-zero / connection refused (down)** ⇒ go to step 4 (**start**).

A successful probe means the server is already running — the port bind held by that process *is* the lock. Do **not** spawn another.

## 3. Up ⇒ focus (open the deep link, no spawn)

Open the deep link from step 1 in the browser, then stop:

```bash
open "<deep-link>"          # macOS; use xdg-open on Linux, start on Windows
```

This is the path a **second invocation** always lands on: the first invocation holds the `:4317` bind, so every later `/agentry:workbench` finds healthz up and simply focuses the existing instance. One server, many named tabs.

For diagnostics only, the running instance's metadata is in the pidfile at `<projectRoot>/.agentry/run/workbench.json` — `{ pid, port, startedAt }` (advisory metadata, written by the server; the port bind, not this file, is the lock). You don't need it to focus — the loopback probe already proved liveness.

## 4. Down ⇒ start (detached spawn, poll, then open)

Spawn the **committed server artifact** detached, so it outlives this command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/workbench/server/index.js"
```

Start it detached/backgrounded (e.g. `nohup … &` or the platform's detach idiom) so the Workbench keeps running after the command returns. The server binds `:4317` (the singleton lock) and writes its own pidfile at `<projectRoot>/.agentry/run/workbench.json` — **this command does not write the pidfile**.

Then **poll `/healthz` until ready**, with a timeout (the server needs a moment to bind):

```bash
# poll up to ~10s, then give up
for i in $(seq 1 20); do
  curl -fsS -m 1 http://127.0.0.1:4317/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
```

- **Became ready** ⇒ open the deep link from step 1 (same `open`/`xdg-open` as step 3).
- **Timed out** (never healthy) ⇒ report the failure — do not open a dead URL. Surface the server's startup output if captured (e.g. the `nohup` log) so the user can see why it didn't bind (an `EADDRINUSE` here would actually mean a race lost to another starter that *is* now up — re-probe once and focus if so).

## Notes

- **Never two servers.** The bind is the lock: if two invocations race, exactly one wins the `:4317` bind; the loser's probe (or its `EADDRINUSE`) sends it down the focus path. Re-probe-then-focus on a lost race rather than erroring.
- **Reload-gated:** this is a new plugin command — it registers only on plugin reload/restart. Its **live** focus-or-start behavior (ADR-002 AC1) and the second-invocation→focus check (AC10) are verified after a restart in **Phase 5**, not at author time; here the flow is correct by inspection.
