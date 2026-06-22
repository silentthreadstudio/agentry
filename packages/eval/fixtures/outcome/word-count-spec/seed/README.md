# wordcount

A tiny CommonJS module exposing `wordCount(text)` — count the words in a string.

A word is a maximal run of non-whitespace; any run of whitespace separates words. Empty or whitespace-only input
has `0` words. Examples:

- `wordCount("hello   world")` → `2`
- `wordCount("  one\ttwo\nthree  ")` → `3`
- `wordCount("   ")` → `0`

`src/wordcount.js` ships a stub that throws; implement it. Keep the CommonJS export
(`module.exports = { wordCount }`). No dependencies.
