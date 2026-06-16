// Renders a small temperature line using the conversion helpers.
const { celsiusToF, round1 } = require('./temp');

function describe(celsius) {
  const f = round1(celsiusToF(celsius));
  return `${celsius}°C is ${f}°F`;
}

module.exports = { describe };
