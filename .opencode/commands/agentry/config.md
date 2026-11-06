---
# Generated from plugin/commands/config.md by scripts/build-opencode.mjs — edit the source, not this file.
description: Show and change Agentry's settings — what's on, what each toggle does, and where it's written. Every default reproduces stock behavior; nothing here is forced.
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
| `mode` | — (none) | A non-empty string naming the working mode (e.g. `night`). `/agentry/start` prints it and the conductor follows the repo's `mode-<name>` skill if there is one; the scripts never interpret it. An empty or non-string value is refused like any bad key, and `/agentry/start` says the config is unreadable rather than "none set". |
| `evolution.enabled` | `false` | Records Evolution entries (harness self-improvement notes). |
| `evolution.path` | — | Optional override for where those are written. |
| `memory.prime` | `conductor` | Whether the commands carry ranked durable facts: `off` (none) · `conductor` (`/agentry/start` prints them for the session; builder and verifier briefs carry none) · `all` (`/agentry/exec` also puts them in each brief, ~200–400 tokens each). |
| `memory.primeLimit` | `5` | Most facts a single recall may carry (recall is few-and-ranked, never a dump). |
| `memory.captureCorrections` | `false` | Distill a `preference` fact when you correct or rewrite the agent's output. Off by default: it writes durable memory as a side effect of ordinary conversation. |
| `merge.push` | `ask` | What `/agentry/merge` does once a task lands: `ask` (ask each time) · `auto` (push) · `never` (keep it local). Any other value is refused, never read as `auto`. |
| `lanes.maxWriters` | `3` | How many builder lanes may write at once; `/agentry/exec` refuses a new one at the limit and names the open ones. A whole number above 0. |

The lane scripts (`scripts/lib/config.mjs`) read the file strictly: an unknown top-level key (a misspelled block such as `marge`), or an unknown key, wrong type or out-of-range value inside `merge` or `lanes`, stops the step with an error naming it, in whichever file it sits.

## 2. Set a key (only when `$ARGUMENTS` is given)

`$ARGUMENTS` is a single `key=value` (dotted path, e.g. `memory.prime=all`).

- **Validate first** against `AgentryConfig` — an unknown key or an out-of-range value is a refusal with the valid options, never a silently-written typo.
- **Write project-local by default** (`<project>/.agentry/config.json`), creating the file and any missing parents, and **merging** — never clobber keys you did not set. Write the global file only if the user explicitly asks for it.
- **Show the before → after** for that key and name the file you wrote.
- **Say what it takes effect on.** Settings are read each time a command runs, so a changed key applies to the next command — no restart. A key that changes plugin registration (commands, agents, skills) is reload-gated; say so.

## Notes

- If the user asks "why did Agentry do X?", checking this config first is usually the fastest answer — a non-default value is the likeliest cause.
- Removing a key from the file restores its default; there is no "unset" ceremony.

See also `/agentry/init`: the setup front door, which shows this config as part of a repo's setup.
