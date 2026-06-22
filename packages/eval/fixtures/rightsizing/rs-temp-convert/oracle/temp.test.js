// HIDDEN held-out oracle — the agent NEVER sees this. It requires the built src/temp.js and asserts the
// Celsius→Fahrenheit contract at known anchor points. The un-fixed seed FAILS (drops +32); a correct fix PASSES.

const test = require("node:test");
const assert = require("node:assert/strict");

const { celsiusToF } = require("../src/temp.js");

test("freezing point: 0C is 32F", () => {
  assert.equal(celsiusToF(0), 32);
});

test("boiling point: 100C is 212F", () => {
  assert.equal(celsiusToF(100), 212);
});

test("negative: -40C is -40F (the crossover)", () => {
  assert.equal(celsiusToF(-40), -40);
});

test("body temp: 37C is 98.6F", () => {
  assert.equal(celsiusToF(37), 98.6);
});
