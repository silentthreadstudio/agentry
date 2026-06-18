# Security Policy

## Supported versions

Agentry is pre-1.0 and ships as a Claude Code plugin. Security fixes target the latest release and `main`.

| Version | Supported |
| :------ | :-------- |
| latest `v0.x` / `main` | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's **[Security Advisories](https://github.com/Codestz/agentry/security/advisories/new)**
(Security → Report a vulnerability). Include:

- a description and impact,
- steps to reproduce or a proof of concept,
- affected version / install method (marketplace, release zip, local),
- any suggested fix.

You can expect an acknowledgement within a few days and a coordinated fix before public disclosure.

## Scope & what to consider

Agentry runs inside Claude Code and ships **markdown** (agents/commands/skills/hooks) plus one local **stdio MCP
server** (the memory bundle at `plugin/mem/index.js`). Areas worth scrutiny:

- the **memory MCP** — it reads/writes files under the resolved memory roots and runs a local `node:sqlite`
  index; path handling and untrusted-input parsing matter,
- **hooks** — the dep-free primer hook runs on session events,
- anything that handles **untrusted repo content** a conductor or agent might read.

Out of scope: vulnerabilities in Claude Code itself (report those to Anthropic), or in third-party tools/MCPs a
user has configured separately.
