# Test Design — depth

Reference for the `testing` skill. The goal of every test: **trustworthy confidence at the lowest maintenance cost.** A test earns its keep by catching a real regression and surviving a harmless refactor.

## The behavior-vs-implementation line (the central skill)

Test *what* the code does (its contract), not *how* it does it.

- **Behavior** — observable through the public surface: return values, emitted events, persisted state, errors raised, messages sent. This is what callers depend on, so this is what must not silently change.
- **Implementation detail** — private methods, internal data structures, the order of internal calls, which helper was used. These are free to change; a test that asserts on them breaks on every refactor and gives false alarms.

**The refactor test:** if you rewrite the internals but keep the contract, your tests should stay green. If they go red, they were testing implementation. **The break test:** if you introduce a real behavior bug, a test should go red. If none does, your tests are decorative.

When the only way to verify something is to reach into internals, treat it as a design smell — the behavior probably wants a real seam to test through.

## The edge / boundary catalog

Bugs cluster at boundaries. Walk this list for the behavior under test:

- **Collections:** empty, one element, many; first and last; all-same; duplicates; unsorted vs. sorted where order matters.
- **Numbers:** zero, negative, the minimum, the maximum, just-below / at / just-above each limit; overflow; floating-point rounding.
- **Strings:** empty, whitespace-only, very long, unicode / multibyte, leading/trailing spaces, embedded separators.
- **Nullability:** null / undefined / missing field / default vs. explicit.
- **Time & order:** timezones, DST, ordering dependencies, concurrent access where relevant.
- **State:** first call vs. repeated call; idempotency; partial / interrupted operations.

You don't need every cell for every function — pick the boundaries the *contract* actually has. A pure formatter cares about strings and unicode; a paginator cares about zero/one/many and off-by-one.

## Test doubles — the spectrum, and when to use which

Reach for the lightest double that isolates what you're testing. More mocking = more coupling to implementation.

- **Real object** — default. Use the actual collaborator when it's fast, deterministic, and has no side effects. The most honest test.
- **Stub** — returns canned data for a query, so you can drive a code path. Use to set up state, not to assert.
- **Fake** — a working lightweight implementation (in-memory repository, in-memory clock). Great for I/O boundaries; behaves enough like the real thing to give real confidence.
- **Mock / spy** — asserts an interaction happened (e.g., "the email was sent"). Use *only* when the interaction itself is the behavior the contract promises. Asserting call counts on incidental collaborators is the over-mocking trap.

Rule of thumb: **mock at the real seam (I/O, network, external service), not inside your own logic.** If a test only proves your mocks were called, it proves nothing about correctness.

## The test pyramid and right-sizing

- **Unit tests** — fast, isolated, many. The bulk of coverage; test one unit's behavior through its surface.
- **Integration tests** — fewer; verify that units wired together (and across a real seam like the DB) actually cooperate. Catch the bugs unit tests can't — wiring, serialization, contracts between modules.
- **End-to-end** — fewest; expensive and slower. Reserve for the critical user-visible path.

Right-sizing means putting each test at the **lowest level that can catch the bug**. Don't write an e2e test for logic a unit test covers; don't unit-test wiring that only an integration test exercises. Match the repo's existing balance and layout.

## Properties of a good test

- **Fast** — runs in milliseconds; slow tests get skipped, and skipped tests catch nothing.
- **Isolated** — no dependence on other tests, run order, or shared mutable state. Each sets up and tears down its own world.
- **Deterministic** — same result every run. No reliance on real time, randomness, network, or wall-clock ordering; inject those so they're controllable. A flaky test is worse than no test — it trains the team to ignore red.
- **One reason to fail** — when it breaks, its name tells you what behavior regressed. A test that can fail for five reasons localizes nothing.
- **Readable** — arrange-act-assert visible at a glance; the test documents the behavior it pins down.

## Right-sized coverage, restated

Coverage percentage is a diagnostic, not a goal. The question is never "what's the number" but **"what would actually break in use, and is it pinned?"** Test the contract's promises and its real edges; stop when another test no longer reduces real risk. Over-testing (asserting internals, testing trivial accessors, duplicating covered cases) is the testing-side equivalent of gold-plating — it adds maintenance without adding confidence.
