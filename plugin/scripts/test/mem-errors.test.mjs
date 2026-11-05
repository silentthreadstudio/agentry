// The error envelopes (lib/memory/tools/errors.mjs) and the results built from them: every refusal carries a
// stable code and prose complete without it; the generic one leaks nothing about the host.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badInput,
  internal,
  invalidState,
  notFound,
  notFoundMany,
  storageRead,
} from "../lib/memory/tools/errors.mjs";
import { partial } from "../lib/memory/tools/result.mjs";

const nonEmpty = (s) => typeof s === "string" && s.length > 0;

test("each builder returns the expected code with non-empty what/why/fix", () => {
  const cases = [
    { env: notFound("fact_1"), code: "not-found" },
    { env: notFoundMany(["a", "b"]), code: "not-found" },
    { env: badInput("limit", "must be > 0"), code: "bad-input" },
    { env: invalidState("w", "y", "f"), code: "invalid-state" },
    { env: storageRead("facts.md"), code: "storage-read" },
    { env: internal(), code: "internal" },
  ];
  for (const { env, code } of cases) {
    assert.equal(env.code, code);
    assert.deepEqual(Object.keys(env), ["code", "what", "why", "fix"]);
    assert.ok(nonEmpty(env.what), `${code}.what non-empty`);
    assert.ok(nonEmpty(env.why), `${code}.why non-empty`);
    assert.ok(nonEmpty(env.fix), `${code}.fix non-empty`);
  }
});

test("notFound surfaces the offending id in why; notFoundMany quotes each id", () => {
  assert.ok(notFound("fact_xyz").why.includes("fact_xyz"));
  assert.match(notFoundMany(["g:1", "g:2"]).why, /"g:1", "g:2"/);
});

test("badInput names the field in fix", () => {
  assert.ok(badInput("limit", "must be > 0").fix.includes("limit"));
});

test("internal leaks no path-like or stack-like substring and takes no argument", () => {
  assert.equal(internal.length, 0);
  const env = internal();
  const blob = `${env.what} ${env.why} ${env.fix}`;
  assert.ok(!blob.includes("/"), "no path-like substring");
  assert.ok(!blob.includes("at "), "no stack-like substring");
});

test("partial: the applied and skipped ids when something applied", () => {
  const outcome = {
    applied: ["a"],
    skipped: [{ id: "b", reason: "no such fact exists" }],
    requested: 2,
  };
  assert.deepEqual(partial(outcome), {
    data: { applied: ["a"], skipped: [{ id: "b", reason: "no such fact exists" }] },
  });
});

test("partial: ids asked for and none applied is a not-found naming them", () => {
  const one = partial({ applied: [], skipped: [{ id: "a", reason: "r" }], requested: 1 });
  assert.equal(one.error.code, "not-found");
  assert.ok(one.error.why.includes('"a"'));
  const many = partial({
    applied: [],
    skipped: [
      { id: "a", reason: "r" },
      { id: "b", reason: "r" },
    ],
    requested: 2,
  });
  assert.ok(many.error.why.includes('"a"') && many.error.why.includes('"b"'));
});

test("partial: nothing asked for is a success with nothing applied", () => {
  assert.deepEqual(partial({ applied: [], skipped: [], requested: 0 }), {
    data: { applied: [], skipped: [] },
  });
});
