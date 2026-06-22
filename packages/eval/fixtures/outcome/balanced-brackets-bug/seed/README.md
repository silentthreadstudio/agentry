# brackets

A tiny CommonJS module exposing `isBalanced(text)` — check that `()[]{}` brackets match and nest correctly.

Examples: `isBalanced("(a[b]{c})")` → `true`, `isBalanced("(a")` → `false`.

There is a bug: a closing bracket that arrives with nothing open is ignored, so `isBalanced("a)")` and
`isBalanced("(a)b)")` wrongly return `true`. Fix the empty-stack case. Keep the CommonJS export
(`module.exports = { isBalanced }`). No dependencies.
