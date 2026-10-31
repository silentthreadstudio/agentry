# Sample task contracts

## 1. Contracts

- **W1** (A1; independent verifier): owns `src/loop.mjs` · exposes `runLoop()` · accept: the loop
  runs headless.
- **W3** (A2): owns `src/clock.mjs` · exposes `clock()` · deps W1, W2 · accept: the clock pauses in
  menus.

**W5 · The door** (B1): owns `src/door.mjs` · accept: the door opens.
