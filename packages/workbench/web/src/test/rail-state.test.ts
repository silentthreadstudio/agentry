// rail-state proof (doc 18 slice 4) — the rail's durable state.
//
// Two lifetimes, deliberately different: the MODE is a workspace preference and persists across a
// reload (AC12); the FOCUSED RUN is per-tab context, so two tabs can watch two runs. Both are wrapped
// against storage that throws — a rail must not take the app down because it could not remember a
// preference.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { MODES, focusRun, focusedRun, loadMode, saveMode } from "../routes/rail/rail-state.js";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const g = globalThis as unknown as { window: unknown };
beforeEach(() => {
  g.window = {
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    CustomEvent: class {
      constructor(
        public type: string,
        public init?: { detail?: unknown },
      ) {}
    },
  };
  (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = (
    g.window as { CustomEvent: unknown }
  ).CustomEvent;
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

test("the default mode is rail — the board leads until told otherwise", () => {
  assert.equal(loadMode(), "rail");
});

test("a saved mode survives (AC12: it outlives a reload)", () => {
  saveMode("focus");
  assert.equal(loadMode(), "focus");
});

test("a junk stored mode falls back to the default rather than breaking the layout", () => {
  (g.window as { localStorage: Storage }).localStorage.setItem(
    "agentry.workbench.rail",
    "enormous",
  );
  assert.equal(loadMode(), "rail");
});

test("the three modes are ordered collapsed → rail → focus, which is what ⌘\\ cycles", () => {
  assert.deepEqual([...MODES], ["collapsed", "rail", "focus"]);
});

test("focusing a run is what the rail reads back", () => {
  assert.equal(focusedRun(), null);
  focusRun("r-1");
  assert.equal(focusedRun(), "r-1");
});

test("storage that throws is survived — no focus, not a crash", () => {
  g.window = {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
    sessionStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
    dispatchEvent: () => true,
  };
  assert.equal(loadMode(), "rail");
  assert.equal(focusedRun(), null);
  assert.doesNotThrow(() => saveMode("focus"));
  assert.doesNotThrow(() => focusRun("r-1"));
});
