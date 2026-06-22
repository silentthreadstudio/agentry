// GOLDEN overlay — a known-correct conversion. seed+golden PASSES the held-out oracle.
function toFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32;
}

module.exports = { toFahrenheit };
