# debounce

A tiny CommonJS module exposing `debounce(fn, ms)` — coalesce a burst of calls into one trailing call.

`src/debounce.js` ships a stub that throws; implement it so:

- a single call runs `fn` once, after `ms` ms
- a rapid burst runs `fn` exactly ONCE, after the burst goes quiet, with the LAST call's arguments

Use the global `setTimeout`/`clearTimeout`. No dependencies; keep the CommonJS export
(`module.exports = { debounce }`).
