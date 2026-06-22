# duration

A tiny CommonJS module exposing `parseDuration(text)` — convert a duration string to total seconds.

Supported units: `s` (seconds), `m` (minutes), `h` (hours). Example: `parseDuration("5m")` → `300`.

There is a bug in the hours conversion. `parseDuration("2h")` returns `720` but should return `7200`. Fix it
without changing the supported units or the CommonJS export (`module.exports = { parseDuration }`). No dependencies.
