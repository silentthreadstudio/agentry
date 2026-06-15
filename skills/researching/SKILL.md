---
name: researching
description: This skill should be used when investigating a genuine unknown — a question that can't be answered from what's already known and must be checked against current sources: a library/framework/API's current behavior or version, an external standard or best practice, a "how does X actually work" question spanning the web and the codebase, or any floating claim that needs verification before work depends on it. Loaded when recency or correctness of an external fact gates a decision, not for things the team already knows.
version: 0.1.0
---

# Researching

Turn an *unknown* into **cited fact** the team can act on. The deliverable is not a summary — it is verified findings plus what they change in the spec or plan. A wrong or unverified finding is worse than none, because the team will build on it.

## The three rules that govern every investigation

1. **Cite every claim.** A fact carries its source — URL + the version/date observed, or `file:line` for repo facts. No source → it is inference, and must be labeled as such.
2. **Distrust stale training.** Training has a cutoff and drifts. Recency-sensitive is broader than versions: **anything whose truth has a date** — a library/framework/API's behavior, but also pricing, current best practice, a revised standard, or any "is X still true" — is verified against current sources, never answered from memory.
3. **Never single-source a load-bearing claim.** Corroborate from a second independent source, or mark it explicitly **unverified**.

## Method

Work in this order; stop as soon as the answer is established and corroborated — don't over-research a settled question. **The symmetric failure is just as real:** the stop-floor is set by the *hardest* claim — the most load-bearing, most recency-sensitive one — **not by the effort already spent.** A load-bearing claim backed by a single source, or one whose recency you couldn't confirm, is **not done** no matter how long you've looked. Over-research and premature-stop are both failures; the hardest claim, not your fatigue, decides which line you're near.

1. **Frame the unknown.** State the precise question and *what decision it gates* in one line. If it can't be framed crisply, narrow it before searching — an unbounded question is a rabbit hole.
2. **Fan out.** Search broadly to surface candidate sources across the web *and* the repo. Cast wide first; you're finding leads, not answers yet.
3. **Narrow to authority.** Triage to the sources that count — primary/official over secondary, current over old, maintained over abandoned.
4. **Fetch and read the real source.** Read the actual page/doc/code, not a search snippet. Note the version and date you're looking at.
5. **Adversarially verify.** For each load-bearing claim: corroborate from a second independent source, check it's current, and reconcile conflicts. Actively try to *disprove* the claim — a fact that survives a real attempt to break it is trustworthy.
6. **Synthesize.** Write findings with claims cited, separating **verified fact** from **inference**, flagging residual uncertainty honestly.

## Capability-first tools

Name the *job*, prefer a tool *if present*, always have a *fallback* — never a hard tool name:

- **Open web** → prefer a web-search/fetch capability (WebSearch / WebFetch) if present → fallback: state that external facts couldn't be verified and ask.
- **Library / framework docs** → prefer a docs MCP (context7 or similar) if present → fallback: fetch the official docs site directly.
- **Repo facts** → prefer a semantic code-intel tool (Serena / LSP) if present → fallback: grep / glob / read.

If a needed capability is absent, do **not** fill the gap with a confident guess. Report what *could* be established, mark the rest **unverified**, and ask for access or a decision to proceed on assumption.

## Fact vs inference vs uncertainty

Three distinct labels, never blurred:

- **Verified fact** — corroborated, current, cited. The team can build on it.
- **Inference** — a reasonable conclusion *you* drew from facts, not a source statement. Labeled as inference, with the facts it rests on.
- **Uncertain / unverified** — couldn't corroborate, sources conflict, or recency couldn't be confirmed. Flagged explicitly so the conductor can gate it.

Honesty here is the whole value. Confident-but-wrong is the failure this skill exists to prevent.

## Scope discipline

- Answer the question asked, at the depth the *decision* needs — no more.
- Stop when the load-bearing claims are corroborated; further reading is diminishing returns.
- Adjacent-but-unasked questions are noted as leads, not chased.

## Anti-patterns (refuse these)

- **Uncited claim** — a fact with no source.
- **Stale-training answer** — answering a recency-sensitive question from memory instead of current sources.
- **Single-source trust** — one unverified source driving a decision.
- **Snippet-answering** — citing or concluding from a search-result snippet or summary without fetching the underlying source. The snippet is a lead, never the citation; open the page and read the real text.
- **Premature stop** — stopping because the effort feels sufficient while a load-bearing claim is still single-sourced or its recency unconfirmed. The hardest claim sets the floor, not the time spent.
- **Scope creep** — chasing the rabbit hole past what the decision needs.
- **False confidence** — inference dressed as fact, or a capability gap hidden behind a guess.

## Output

A **Research** doc: `## Findings` (each claim cited, fact-vs-inference distinguished, uncertainty flagged) + `## Implications` (exactly what this changes in the spec/plan, or "confirms current plan"). Report any memory that shaped the research in `used_memories`, and list any unverifiable items for the conductor to gate.

## Additional resources

### Reference files
- **`references/search-craft.md`** — query-formulation craft: phrasing queries in specific terms / error strings / versions, engine-agnostic operators, narrowing vs broadening a failing query, multi-query decomposition, and recency handling.
- **`references/verification-playbook.md`** — source-authority ranking, the corroboration & recency protocol, how to attack a claim, handling conflicting sources, and the citation format for findings.
