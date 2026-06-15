# `@agentry/selfeval` — the routing-accuracy self-eval

An early-signal instrument (N=6–8, directional — not a powered benchmark) that measures whether Agentry's
conductor routes a task to the right shape: **one-shot** vs **spec-first** vs **decompose**. It captures the
conductor's `claude -p` event stream, infers the dispatched shape from the stream, compares it to a labeled
floor, and emits an accuracy % + confusion matrix **only after** three control gates pass — so a misaimed
eval is structurally impossible.

This package is **self-contained**: it imports nothing from `benchmark/` (the demoted scoring world). It
mirrors `benchmark/`'s run model — its own `package.json` + `tsconfig.json`, run via `tsx`, **no build /
bundle / `dist`** — and is dev-only.

## Layout

- `src/io/` — the volatile I/O edge, **ported** from `benchmark/`'s proven runner + sandbox, trimmed of every
  scoring concern:
  - `port.ts` — `RunResult` (the minimal per-run record), `Sandbox`, `Invocation`, `Runner`.
  - `live.ts` — `liveRunner`: streams `claude -p --output-format stream-json --verbose`, tees to
    `stream.jsonl`, and kills the child on the first `Agent` dispatch (early-terminate). Capture is the only
    mode — there is no scoring path.
  - `replay.ts` — `replayRunner` / `replaySequenceRunner`: zero-API test doubles over recorded `RunResult`s.
  - `sandbox.ts` — `prepareSandbox()`: a fresh temp working dir + two relocated memory roots per run.
- `src/routing/` — the routing probe (shape vocab, extractor, fixture loader, controls, probe/artifact/command).
  *Built by later tasks.*

### The minimal run record

```ts
interface RunResult {
  streamPath: string;            // the captured stream.jsonl this run wrote (the extractor's only file input)
  resultSubtype?: string;        // result.subtype when the run settled (one-shot / no-dispatch runs)
  producedTreeNonEmpty: boolean; // the one-shot disambiguator's tree signal
}
```

No cost, no grade, no raw envelope — exactly what the extractor's one-shot disambiguator needs.

> The per-run capture file is always **`stream.jsonl`**, never `events.jsonl` (the primer hook owns that name
> in the work dir).

## Develop

```sh
cd selfeval
npm install            # mirrors benchmark's deps: tsx + types + yaml
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm test               # node --import tsx --test test/*.test.ts  (zero API spend — fake child / replay)
```

The live capture path (`liveRunner`) is the only code that would spend API; the tests never invoke it (a fake
child drives the capture logic). The live reliability of `proc.kill()` leaving a well-formed partial
`stream.jsonl` is a separate live probe (R1).
