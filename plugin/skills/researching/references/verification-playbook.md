# Verification Playbook — depth

Reference for the `researching` skill. The job is one thing: produce claims a skeptic can't knock down. Everything here serves that — rank what you trust, corroborate it, attack it, and cite it so the next reader can re-check.

## Source-authority ranking

Not all sources are equal. Prefer, in order:

1. **Primary / official** — the project's own docs, the spec/RFC itself, the source code, the changelog/release notes. The maintainer is the authority on their own API.
2. **Maintained secondary** — current, well-regarded references that track upstream (official guides, reputable framework handbooks).
3. **Community current** — recent issues, discussions, Q&A — useful for "does it actually work," but corroborate against (1).
4. **Stale / unattributed** — old blog posts, undated answers, AI summaries. Treat as *leads to verify*, never as the citation.

A high-authority source still gets a recency check; an official doc for the wrong version is wrong.

## The corroboration protocol

For every **load-bearing** claim (one a decision rests on):

1. Establish it from a primary source.
2. Confirm it from a *second independent* source — not a mirror of the first.
3. If the two agree → **verified fact**, cite both.
4. If only one source exists → mark **unverified (single-source)** and say so in the finding.
5. If they conflict → see *Conflicting sources* below.

Non-load-bearing context (background color that doesn't drive a decision) can carry a single citation — but still a citation.

## The recency check

Stale facts are the dominant failure mode for libraries and frameworks. For anything version-sensitive:

- Identify the **version** the question is about (the user's installed version, or "current").
- Confirm the source documents *that* version — check the version selector, the changelog, the "since X.Y" notes.
- Note the **date** you observed the source in the citation. "As of <date>" is part of the fact.
- When behavior changed across versions, report the change and which version the team is on — that *is* the finding.

Never let training memory substitute for this. If you "know" an API, verify it anyway; APIs you knew have changed.

## How to attack a claim

Verification is adversarial — try to *break* the claim, not confirm it:

- **Seek the disconfirming source.** Search for "X doesn't work" / "X deprecated" / "X breaking change," not just "X how to."
- **Check for deprecation / removal.** A real-once fact may be retired now.
- **Find the edge.** Does the claim hold in the user's exact context (version, platform, config), or only in the happy path?
- **Question the chain.** If source B just cites source A, you have *one* source, not two.

A claim that survives a genuine attempt to falsify it is trustworthy. One you only ever tried to confirm is not.

## Conflicting sources

When good sources disagree:

- Present **both** positions; don't silently pick one.
- Weigh by **authority** (primary > secondary) and **recency** (current > old) — the newer official source usually wins.
- State which you'd **act on** and the **residual risk** if it's wrong.
- If the conflict is unresolved and load-bearing, flag it for the conductor to gate rather than guessing.

## Repo facts

Investigating the codebase is research too:

- Cite as `path/to/file:line` (or symbol) — the same traceability bar as a URL.
- Prefer a semantic code-intel tool to find true definitions/usages over text grep, which catches lookalikes.
- Verify the code *is what runs* — check it's not dead code, behind a flag, or shadowed by config.

## Citation format for findings

Each finding is a claim plus its evidence, with its confidence visible:

```
- [fact] <claim>. — <source URL>, v<version> (seen <date>); corroborated by <2nd source>.
- [fact] <claim>. — <file:line>.
- [inference] <conclusion>, drawn from the two facts above. (not stated by any source)
- [unverified] <claim>. — single source <URL>; could not corroborate. Gate before acting.
```

The label (`fact` / `inference` / `unverified`) is mandatory — it's how the reader knows how much weight the claim can bear.

## Knowing when to stop

Research is bounded by the decision, not by curiosity:

- Stop when every load-bearing claim is corroborated and current.
- Further reading past that point is scope creep — note any loose ends as leads and hand back.
- If the answer turns out to be a *design choice* rather than a discoverable fact, stop researching and route it to the architect.
