---
description: Show and change Agentry's settings — what's on, what each toggle does, and where it's written. Every default reproduces stock behavior; nothing here is forced.
argument-hint: "[key=value] — set a key (e.g. memory.prime=all); omit to just show the current config"
---

Show — and optionally change — Agentry's configuration for this project.

**The contract this command exists to keep:** Agentry proposes, you dispose. Every key below has a default that reproduces stock behavior, nothing is enabled behind your back, and a repo with no `config.json` at all behaves exactly like the shipped defaults describe. This command is how those toggles stay *discoverable* — a setting nobody can find is not really optional.

## Where config lives

Read in this order, first hit wins: `<project>/.agentry/config.json`, then `~/.agentry/config.json`. The contract is `AgentryConfig` in `@agentry/core` (`packages/core/src/config.ts`) — that file is the source of truth for keys and defaults; read it rather than trusting this list if the two ever disagree.

## 1. Show the effective config

Read both files (either may be absent — that is normal and means "all defaults"), and present a table: **key · current value · default · what it does**. Mark any key whose current value differs from the default so a surprising behavior is traceable in one glance. Say which file each non-default value came from.

Current keys:

| Key | Default | What it does |
|---|---|---|
| `workDir` | `.agentry` | Where run artifacts and memory live. |
| `evolution.enabled` | `false` | Records Evolution entries (harness self-improvement notes). |
| `evolution.path` | — | Optional override for where those are written. |
| `memory.prime` | `conductor` | Who gets ranked durable facts injected before working: `off` (nobody) · `conductor` (the main session, on each prompt) · `all` (also every dispatched subagent, ~200–400 tokens each). |
| `memory.primeLimit` | `5` | Most facts a single priming injection may carry (recall is few-and-ranked, never a dump). |
| `memory.captureCorrections` | `false` | Distill a `preference` fact when you correct or rewrite the agent's output. Off by default: it writes durable memory as a side effect of ordinary conversation. |

## 2. Set a key (only when `$ARGUMENTS` is given)

`$ARGUMENTS` is a single `key=value` (dotted path, e.g. `memory.prime=all`).

- **Validate first** against `AgentryConfig` — an unknown key or an out-of-range value is a refusal with the valid options, never a silently-written typo.
- **Write project-local by default** (`<project>/.agentry/config.json`), creating the file and any missing parents, and **merging** — never clobber keys you did not set. Write the global file only if the user explicitly asks for it.
- **Show the before → after** for that key and name the file you wrote.
- **Say what it takes effect on.** Hook-driven settings (anything under `memory.prime`) are read per invocation, so they apply to the next prompt or the next dispatched subagent — no restart. A key that changes plugin registration (hooks, commands, agents) is reload-gated; say so.

## Notes

- If the user asks "why did Agentry do X?", checking this config first is usually the fastest answer — a non-default value is the likeliest cause.
- Removing a key from the file restores its default; there is no "unset" ceremony.
