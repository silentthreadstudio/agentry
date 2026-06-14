---
name: testing
description: This skill should be used when designing or writing tests for code — deciding what to test, structuring a test (arrange-act-assert), covering edge and boundary cases, and choosing right-sized coverage that proves the acceptance without over-testing. Loaded alongside implementation work; covers test design, not test-runner setup or CI configuration.
version: 0.1.0
---

# Testing

Write tests that **prove the behavior the contract promises** and **fail for the right reason** — enough to trust the change, not a suite for its own sake. A good test catches a real regression and survives a harmless refactor. A bad test passes when the code is broken, or breaks when nothing important changed.

## The one rule that governs every test

**Test behavior and contract, not implementation details.** Assert on the observable result of the public surface — what a caller sees — not on private internals, call counts, or how the work is done. A test coupled to internals breaks on every refactor and gives false confidence; a test coupled to behavior is the regression net you actually want. If you can't test it through the public surface, the design may be the problem, not the test.

## What to test (prioritize)

1. **The happy path of the exposed behavior** — the contract's core promise, with realistic input.
2. **Edge and boundary cases** — the places bugs hide:
   - empty / zero / one / many; the first and last element; off-by-one boundaries.
   - null / missing / undefined inputs; empty string vs. whitespace.
   - min / max / overflow; just-below, at, and just-above each limit.
   - duplicates, ordering, and unsorted input where order matters.
3. **Error and failure paths** — invalid input rejected the way the contract says; failures surfaced, not swallowed.
4. **Regressions** — every fixed bug gets a test that reproduces it, so it can't return silently.

Don't test the language, the framework, or third-party libraries — assume they work. Test *your* logic and *your* boundaries.

## How to structure a test (arrange-act-assert)

- **Arrange** — set up inputs and state; keep it minimal, only what this case needs.
- **Act** — invoke the one behavior under test (a single action, not a workflow).
- **Assert** — check the observable outcome. Prefer **one logical assertion per test**; many micro-asserts on one result is fine, but don't test three unrelated behaviors in one case.

Name the test for the behavior and condition (`returns_empty_when_no_match`, not `test1`). The name should tell you what broke without reading the body. One reason to fail per test — when it goes red, the name localizes the bug.

## Right-sized coverage (don't gold-plate)

Coverage is a means, not a target. Aim for **the cases that would actually break in use**, not a percentage.

- A one-line fix needs the regression test, not a suite.
- A bounded feature needs happy path + the real edges + the error paths in its contract.
- Match the repo's test style, layout, and runner — put tests where the repo puts them, name them how the repo names them.
- **Stop when adding a test no longer reduces real risk.** Testing every trivial getter, asserting on internals, or duplicating a case you already cover is over-testing — the testing-side gold-plating.

## Anti-patterns (refuse these)

- **Testing implementation details** — asserting on internals / call order / private state; breaks on refactor.
- **Assertion-free tests** — code that runs but checks nothing ("it didn't throw" is rarely enough).
- **Over-mocking** — mocking so much that the test only proves the mocks were called, not that the code works.
- **Coverage-chasing** — tests written to hit a number, not to catch a bug.
- **Flaky tests** — depending on time, order, network, or shared state; a test that fails randomly trains everyone to ignore failures.
- **One test, many behaviors** — when it breaks, you can't tell what's wrong.

## Output

A right-sized set of tests covering the exposed behavior and its real edges, structured arrange-act-assert, asserting on observable outcomes, green in the repo's runner. Report any memory that shaped the test design in `used_memories`.

## Additional resources

### Reference files
- **`references/test-design.md`** — the behavior-vs-implementation line in depth, the edge/boundary catalog, the test-double spectrum (when to mock/fake/stub vs. use the real thing), the test pyramid and right-sizing across unit/integration, and the properties of a good test (fast, isolated, deterministic, one-reason-to-fail).
