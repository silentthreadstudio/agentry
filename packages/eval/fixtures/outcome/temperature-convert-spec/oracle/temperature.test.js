// HIDDEN held-out oracle — the agent NEVER sees this. It pins the unambiguous conversions of the formula
// F = C * 9/5 + 32; rounding/precision choices beyond these are the agent's to make.

const test = require("node:test");
const assert = require("node:assert/strict");

const { toFahrenheit } = require("../src/temperature.js");

test("freezing point of water", () => {
  assert.equal(toFahrenheit(0), 32);
});

test("boiling point of water", () => {
  assert.equal(toFahrenheit(100), 212);
});

test("the scales cross at -40", () => {
  assert.equal(toFahrenheit(-40), -40);
});

test("body temperature", () => {
  assert.equal(toFahrenheit(37), 98.6);
});

test("a round positive step", () => {
  assert.equal(toFahrenheit(20), 68);
});
