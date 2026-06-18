<p align="center">
  <img src="assets/logo.jpg" alt="Agentry" width="620">
</p>

<p align="center">
  <b>An adaptive agentic layer for Claude Code.</b><br>
  Same model — disciplined structure around it, and a memory that compounds.
</p>

<p align="center">
  <code>v0.1</code> &nbsp;·&nbsp; <code>measured · controlled · reproducible</code> &nbsp;·&nbsp; <code>Node ≥ 24</code> &nbsp;·&nbsp; <code>MIT</code>
</p>

---

Agentry wraps Claude Code in **right-sized orchestration**, a roster of **SDLC specialists**, and
**durable memory**. It applies the *least process that wins*: trivial work goes one-shot with no
orchestration tax; hard work earns a spec, a plan, and independent verification. The model doesn't
change — the **conducting, the specialists, and the learning memory are the product**.

And unusually for this category: **we measure it.** Agentry ships a self-evaluation harness that scores
its own routing, decision quality, and memory-compounding — every number controlled, read from real work
artifacts, and reproducible from one command. Not asserted. *Measured.*

<p align="center">
  <img src="assets/what-is-agentry.png" alt="What is Agentry" width="820">
</p>

## Why it exists

Dropping a powerful model into a hard task and hoping is not engineering. Teams want the *judgment* of a
senior engineer: knowing when a one-liner is a one-liner and when a "small change" hides a load-bearing
decision; spec'ing before building when it matters; never re-deciding what was already decided last week.

Agentry encodes that judgment as a system — and then holds itself to it with an eval that keeps catching
its *own instrument* being wrong.

## The three pillars

### 1 · The brain — a conductor that right-sizes the work

<img src="assets/icon-brain.png" alt="The brain" width="92" align="left">

A conductor (the main session) routes every task to the **least process that wins** —
`one-shot → spec-first → decompose+verify` — and dispatches specialist subagents only when the work earns
them. It's **biased to the floor** and escalates *on evidence*: a hidden decision fork vetoes a one-shot;
multiple coupled components earn a decompose. It never re-implements what a specialist or a node already does.

<br clear="left">

### 2 · Memory — the moat that compounds

<img src="assets/memory.png" alt="Memory" width="820">

A local, **zero-install** MCP. **Text files are the source of truth; a derived `node:sqlite` index** powers
recall. Recall ranks by *relevance × confidence × usefulness*, auto-writes through a write-bar, auto-prunes
by decay, and runs a graduation pipeline (**episodes → facts → skills**) so the store gets *warm*. The
payoff, **measured** (see below): the second time Agentry meets a decision it settled before, it **recalls
it, applies it, and routes the task lighter** — spec-first becomes one-shot.

### 3 · The harness — breadth without the orchestration tax

<img src="assets/harness.png" alt="The coding harness" width="820">

A roster of capability-first specialists wraps the model in an SDLC: explore → research → spec → plan →
split → implement → verify → assemble → reflect → remember. Each is a preloaded **skill**; each uses
*whatever tools you have* (Serena, web search, a browser MCP…) and degrades gracefully when one's absent.
No tool allowlists.

## Does it actually work? — yes, and we measure it

We don't lead with a hero number. We lead with **how we know** — because the trust machinery *is* the
product. Every number is gated by controls before it's shown, and read from the conductor's **real work
artifacts**, never a proxy.

| Dimension | What it measures | Result | Trust controls |
| :--- | :--- | :--- | :--- |
| **Routing** | Does it right-size to the labeled floor? | **100%** to-floor · **88.9% ± 15.7%** across repeats | A/A unanimity · saturation guard · planted positive |
| **Decision quality** | Is the spec/plan senior-grade? | **97.5%** over 12 judged artifacts | gold **100%** ↔ poor **20%** discrimination · A/A judge σ = 0 |
| **Memory moat** | Does recall make work route lighter? | **compounds** — spec-first → one-shot; discrimination **1.0** | decoy control · seed-landing gate |

> **The corrections log is the real story.** Building the instrument, it disagreed with the conductor **six
> times** — and *every time, the conductor was right and the meter was wrong* (a proxy that scored an
> escalation as a one-shot; a timing bug that killed a slow planner; an "under-route" that was actually a
> good decision shipping a 98%-quality spec). We fixed the **meter**, not the conductor. A number that
> survived its own instrument being wrong six times is a number you can believe.

**Reproduce it yourself** — the eval is self-contained and runs through the real front door:

```bash
cd packages/eval && npm install
npm run selfeval -- run routing  --fixture fixtures/routing-quick --runs 3 --plugin-dir ../..
npm run selfeval -- run quality  --from-run <run-id>      # judges stored specs — zero re-run
npm run selfeval -- run moat     --fixture fixtures/moat   --plugin-dir ../..
npm run selfeval -- report       <run-id>                 # → a self-contained dashboard HTML
```

`report` emits a single static dashboard (routing accuracy, decision quality, the memory moat, and the
corrections log) — *run the eval, get the page.*

## The roster — eight SDLC specialists

Each agent owns one slice of the SDLC. Its craft is **composed from preloaded skills** (the durable
know-how), and it's **capability-first** — no `tools:` allowlists; it uses whatever you have (Serena, web
search, a browser MCP…) and degrades gracefully when one's absent. The conductor dispatches a specialist
only when the work *earns* it; it never re-implements what an agent already does.

| Agent | What it does | Composed from | The conductor dispatches it when… |
| :--- | :--- | :--- | :--- |
| **architect** | Turns a spec or under-specified goal into sound structure — module boundaries, ADRs, a Plan with an architecture map, then bounded Task contracts | `architecting` · `planning` | work is multi-file, structurally non-trivial, or hinges on a real design fork |
| **implementer** | Writes clean, bounded code **and tests** to a Task contract; also the debugging mode (reproduce → fix the smallest thing → prove it) | `implementing` · `testing` | a Task with a contract exists — or a clear, reversible one-shot fix |
| **verifier** | Adversarial, **independent** verification against acceptance + a security lens (injection, authz, SSRF, secrets); returns a Verdict, never fixes | `reviewing` · `integrating` | a builder reports "done", or the assembled product needs an end-to-end check |
| **explorer** | Read-only comprehension of an existing codebase → a Context map (where things live, conventions in force, how data flows) | `exploring` | the work touches code Agentry hasn't mapped yet |
| **researcher** | Investigates genuine unknowns (a library's current API, an external standard) → **cited** findings + their implications | `researching` | a decision is blocked on an external fact where recency/correctness matters |
| **product-owner** | Owns the *what & why* — turns "make X better" into a Spec with **observable** acceptance criteria; also docs, READMEs, release notes | `product` · `writing` | the ask is vague, product-shaped, or user-facing and "done = X" isn't clear yet |
| **designer** | UX/UI craft — hierarchy, layout, accessibility, design-system fit — verified against the **rendered** result (the see-it loop), not asserted | `designing` | the work bears a UI: a new screen, a visual/layout change, an a11y fix |
| **librarian** | Runs the memory flows — reflect (curate), distill (episodes→facts), consolidate (**propose** a skill); keeps recall few, ranked, never-superseded | `remembering` | after non-trivial work, or when memory needs grooming |

## Commands — the nodes

Every step of the SDLC is a **node**: a standalone command that does one job and emits one **typed
artifact** — a Spec, a Plan, a Task, a Verdict, a Context map, an Episode. `/agentry:go` is the conductor —
it *right-sizes which nodes to run* and chains them for you. But every node also **stands alone**, and they
**compose** because they share one typed contract (`@agentry/core`): the artifact one node emits is exactly
what the next node consumes. Run the whole pipeline through the front door, or drive a single node by hand —
same machinery.

| Command | What it does | Runs | Emits |
| :--- | :--- | :--- | :--- |
| **`/agentry:go <task>`** | **The front door.** Right-sizes the task (`one-shot → spec-first → decompose+verify`) and conducts it end-to-end, dispatching only the nodes it earns | conductor (`conducting`) | the finished, verified work |
| `/agentry:onboard` | Comprehend a repo read-only and seed durable repo-facts — warms a cold codebase | explorer | a Context map |
| `/agentry:research <q>` | Investigate an unknown across web + repo | researcher | cited findings |
| `/agentry:spec <goal>` | Turn a goal — especially "make X better" — into observable acceptance criteria | product-owner | a Spec |
| `/agentry:plan` | Design the approach + record the ADRs for the real forks | architect | a Plan (+ ADRs) |
| `/agentry:split` | Slice the plan's architecture map into parallel-safe Task contracts | architect | Task contracts |
| `/agentry:implement` | Build one task — clean, bounded code and tests within its contract | implementer | code + tests |
| `/agentry:verify` | Adversarially verify one task against its acceptance (separate from the author) | verifier | a Verdict |
| `/agentry:assemble` | Run the **whole** product against the spec as observed behavior — the integration gate | verifier | an integration Verdict |
| `/agentry:reflect` | Curate memory and distill the run's episodes into durable facts; proposes skills (human-gated) | librarian | durable facts |
| `/agentry:remember <fact>` | Capture a durable memory now — straight through the write-bar | — (direct, no subagent) | a stored memory |

## Install

**Requires Node ≥ 24** (the memory MCP uses the built-in `node:sqlite`). From a Claude Code session:

```
/plugin marketplace add Codestz/agentry
/plugin install agentry@agentry-dev
```

Restart the session (agents, hooks, and the `mem` MCP load at startup), then:

```
/agentry:onboard                                       # warm memory on this repo (read-only)
/agentry:go "add pagination to the users endpoint"     # the adaptive front door routes it
```

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev setup (pnpm workspace, the
`check-plugin` gate, dist-lockstep) and the bar a change is held to.

## License

MIT
