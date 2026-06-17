// Temperature conversion helpers.

function celsiusToF(c) {
  return c * 9 / 5;
}

function fToCelsius(f) {
  return (f - 32) * 5 / 9;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { celsiusToF, fToCelsius, round1 };
