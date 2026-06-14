import assert from "node:assert/strict";
import { test } from "node:test";
import { badInput, internal, invalidState, notFound, storageRead } from "../src/tools/errors.js";
import { err, ok } from "../src/tools/result.js";

const nonEmpty = (s: unknown): boolean => typeof s === "string" && s.length > 0;

test("each builder returns the expected code with non-empty what/why/fix", () => {
  const cases = [
    { env: notFound("fact_1"), code: "not-found" },
    { env: badInput("limit", "must be > 0"), code: "bad-input" },
    { env: invalidState("w", "y", "f"), code: "invalid-state" },
    { env: storageRead("facts.md"), code: "storage-read" },
    { env: internal(), code: "internal" },
  ];
  for (const { env, code } of cases) {
    assert.equal(env.code, code);
    assert.ok(nonEmpty(env.what), `${code}.what non-empty`);
    assert.ok(nonEmpty(env.why), `${code}.why non-empty`);
    assert.ok(nonEmpty(env.fix), `${code}.fix non-empty`);
  }
});

test("notFound surfaces the offending id in why", () => {
  assert.ok(notFound("fact_xyz").why.includes("fact_xyz"));
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

test("err produces isError:true with { error: <envelope> } nesting", () => {
  const result = err(notFound("x"));
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.error.code, "not-found");
  assert.ok(nonEmpty(parsed.error.what));
});

test("ok stays a success response — no isError flag", () => {
  const result = ok({ value: 1 });
  assert.equal("isError" in result, false);
  assert.equal(JSON.parse(result.content[0].text).value, 1);
});
