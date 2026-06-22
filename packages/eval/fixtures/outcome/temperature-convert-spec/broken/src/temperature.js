// BROKEN overlay — a planted-WRONG conversion. seed+broken FAILS the held-out oracle.
// The bug: it inverts the ratio (5/9 instead of 9/5) — the Fahrenheit→Celsius factor. So toFahrenheit(100)
// yields ~87.6 instead of 212, failing every assertion but the trivial offset.
function toFahrenheit(celsius) {
  return (celsius * 5) / 9 + 32;
}

module.exports = { toFahrenheit };
