// process-identity — the per-process holder of which runs/session this process operated on. Module
// singleton state, so each test resets first (the reset is itself under test).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  __resetProcessIdentity,
  knownRuns,
  knownSessionId,
  noteRunArg,
  noteSessionArg,
} from "../src/resolution/process-identity.js";

beforeEach(() => {
  __resetProcessIdentity();
});

test("noteRunArg accumulates non-empty runs; knownRuns reflects them", () => {
  noteRunArg("run-a");
  noteRunArg("run-b");
  noteRunArg("run-a"); // dedup
  assert.deepEqual([...knownRuns()].sort(), ["run-a", "run-b"]);
});

test("noteRunArg ignores absent/empty runs", () => {
  noteRunArg(undefined);
  noteRunArg("");
  assert.equal(knownRuns().size, 0);
});

test("noteSessionArg records the FIRST non-empty session id; later ids don't override", () => {
  noteSessionArg("sess-1");
  noteSessionArg("sess-2");
  assert.equal(knownSessionId(), "sess-1");
});

test("noteSessionArg ignores absent/empty until a real id arrives", () => {
  noteSessionArg(undefined);
  noteSessionArg("");
  assert.equal(knownSessionId(), undefined);
  noteSessionArg("sess-late");
  assert.equal(knownSessionId(), "sess-late");
});

test("__resetProcessIdentity clears both runs and session", () => {
  noteRunArg("run-a");
  noteSessionArg("sess-1");
  __resetProcessIdentity();
  assert.equal(knownRuns().size, 0);
  assert.equal(knownSessionId(), undefined);
});
