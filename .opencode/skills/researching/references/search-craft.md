# Search Craft — query formulation

Reference for the `researching` skill. The job here is narrow and concrete: **turn an unknown into the right query, and turn a failing query into a better one.** Source-tiering, adversarial corroboration, and when-to-stop live in `verification-playbook.md` — this file is the step before all of that: getting the search itself to return the source you need.

## Query the machine, not a person

A search engine matches tokens, not intent. Phrase the query in the **specific terms the answer would contain** — exact identifiers, error strings, version numbers, API symbol names — not a prose question in your own words.

```
bad:  why does my build fail
good: "Cannot find module '<pkg>'" <runtime> <version> <bundler>

bad:  how do I paginate results in this ORM
good: <orm-name> cursor pagination findMany since:<version>

bad:  is this function deprecated
good: <symbol-name> deprecated <library> changelog
```

Paste error strings **verbatim** (in quotes) — the stack-trace line is the most distinctive token you have. Include the tool and version next to it: the same error means different things across versions.

## Operators (engine-agnostic — they vary)

Most engines support some of these; the exact syntax differs, so treat them as a toolkit, not a contract:

- `"exact phrase"` — quote a literal string (error messages, API names, multi-word terms) so it isn't split.
- `site:` — scope to one domain or docs host (`site:docs.<project>.org`) to cut marketing/SEO noise.
- `-exclude` — drop a recurring noise term (`-tutorial`, `-<unrelated-meaning>`).
- `filetype:` — restrict to a format (`filetype:pdf` for specs/papers, `filetype:md` for docs).
- `intitle:` / `inurl:` — require the term in the page title or URL (finds canonical pages, not passing mentions).
- date-scoping / recency filters — limit to a time window for fast-moving topics (see Recency below).

If an operator returns nothing or behaves oddly, the engine may not support it — see the closing note.

## Iterate: narrow when flooded, broaden when starved

A first query rarely lands. Read the result *shape*, then adjust in one direction:

- **Too much / too generic** → *add constraints.* Add the version, the exact symbol, a `site:` scope, a `-exclude` for the dominant wrong meaning, or quote a phrase to force it.
- **Too little / nothing useful** → *drop terms and generalize.* Remove the most specific token, try a synonym, search the **underlying concept** instead of your exact phrasing, or strip an operator that may be over-filtering.

Change **one thing per iteration** so you can tell what moved the results.

## Decompose a compound question

A question with multiple unknowns is multiple searches, not one. Split it and run each as its own query:

- Searching `"<error string>" <library> v3 breaking` answers *what broke*.
- Searching `<concept> <library> how it works` answers *why*.
- Searching `<library> changelog v2 v3` answers *what changed between versions*.

Three focused queries beat one overloaded query that satisfies none of the terms well.

## Source-tier triage (recap)

Rank what a result is worth before trusting it: **primary docs / changelog / source > reputable maintained reference > community current > undated blog / search snippet.** The full ladder and the corroboration protocol are in `verification-playbook.md` — this is the one-line reminder while you're still choosing which result to open.

## Recency handling

For anything whose truth has a date — versions, pricing, current best practice, revised standards, "is X still true" — bias the search toward **dated and versioned** sources:

- Add the **year** (or the target version) to the query for fast-moving topics.
- Use the engine's **date-scoping / recency filter** to drop stale results.
- After opening a source, **check its publish/updated date** and confirm it documents the version in question — an undated or wrong-version page is a lead, not a citation.

## When to stop

Stop when the load-bearing claims are **corroborated, current, and fetched from the real source — not the snippet.** The full stop-floor (set by the hardest, most recency-sensitive claim) is in `verification-playbook.md` → *Knowing when to stop*.

## Anti-pattern

- **Snippet-answering** — concluding from a search-result snippet or summary without opening the underlying source. The snippet is a *lead* that tells you which result to fetch; it is never the citation. Open the page, read the real text, capture its version and date.

---

**Engine-agnostic.** Operators and filters vary by search engine, and they change. If a query underperforms or an operator seems ignored, the researcher **validates the operator set live** (test it on a known query) rather than assuming it works — then adjusts.
