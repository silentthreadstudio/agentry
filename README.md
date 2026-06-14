# Agentry

**An adaptive agentic layer for Claude Code.** Same model — disciplined structure around it.

Agentry wraps Claude Code in **right-sized orchestration**, a roster of **SDLC specialists**, and
**durable memory that compounds across sessions**. It applies the *least process that wins*: trivial
work goes one-shot with no orchestration tax; hard work gets the full graph. The model doesn't change —
the agents, skills, and learning memory are the product.

> **Status:** design complete (9 internal design docs), specialist roster authored, plugin assembled and
> installable. The memory MCP (`@agentry/memory`) and the benchmark harness are implemented next; the
> Workbench is V2. This README describes what's built — numbers land once the benchmark runs.

## The three pillars

1. **The brain** — a conductor (the main session) that right-sizes a task (`one-shot` → `spec-first` →
   `decompose+verify`) and dispatches specialist subagents. Biased to the floor; escalates only on
   evidence. It never re-implements what a node or agent does.
2. **Memory (the moat)** — a local, zero-install MCP. **Text files are the source of truth; a derived
   `node:sqlite` index** powers recall. Auto-write + auto-prune, a usefulness signal so recall improves,
   and a graduation pipeline (episodes → facts → skills) so the store gets *warm*. The second time
   Agentry does similar work, it's faster and better.
3. **The Workbench (V2)** — a review surface over the markdown artifacts: read, edit, comment, approve.
   V1 ships the seams (artifacts, status/lock, event log, review sidecar) it builds on.

## The roster

| Team | Specialists |
| :--- | :--- |
| **Dev** | explorer · researcher · architect · implementer · verifier · librarian |
| **Product** | product-owner · designer |

Each agent's craft is a preloaded **skill** (12 of them — `architecting`, `planning`, `implementing`,
`testing`, `reviewing`, `integrating`, `exploring`, `researching`, `remembering`, `product`, `writing`,
`designing`). Agents are **capability-first**: they use whatever tools/MCPs you have (Serena, web search,
a browser MCP…) and degrade gracefully when something's absent. No tool allowlists.

## Commands

- **`/agentry <task>`** — the front door. Routes and conducts.
- Nodes: `/agentry:onboard · :research · :spec · :plan · :split · :implement · :verify · :assemble ·
  :reflect · :remember` — each standalone and composable.

## Install

**Requires Node ≥ 24** (the memory MCP uses the built-in `node:sqlite`). From a Claude Code session:

```
/plugin marketplace add /absolute/path/to/agentry
/plugin install agentry@agentry-dev
```

Restart the session (agents, hooks, and the `mem` MCP load at startup), then:

```
/agentry:onboard                                   # warm memory on this repo (read-only)
/agentry "add pagination to the users endpoint"    # the adaptive front door routes it
```

## Repository layout

```
agentry/                  # repo root = the Claude Code plugin
├── .claude-plugin/       # plugin + marketplace manifests
├── agents/ commands/ skills/ hooks/   # the shipped plugin payload
├── .mcp.json             # wires @agentry/memory (the `mem` server)
├── packages/
│   ├── core/             # @agentry/core — the typed contract
│   ├── memory/           # @agentry/memory — the durable memory MCP
│   └── workbench/        # V2
├── benchmark/            # the honest scoreboard (win-conditions C1–C4)
├── scripts/              # check-plugin gate
└── .docs/internal/       # the design docs (01–09)
```

## Design

The full design lives in [`.docs/internal/`](./.docs/internal/) — content generation, memory, the brain,
the roster, the benchmark, the memory MCP, the workbench, and the repo architecture. Win-conditions are
defined up front so the proof can't move its goalposts.

## License

MIT
