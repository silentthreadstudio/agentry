# temp

A tiny CommonJS module exposing `celsiusToF(c)` — convert a Celsius temperature to Fahrenheit.

There is a bug: the formula drops the `+ 32` offset, so `celsiusToF(0)` returns `0` (should be `32`). Fix the
formula. Keep the CommonJS export (`module.exports = { celsiusToF }`). No dependencies.
