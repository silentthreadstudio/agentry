// BROKEN overlay — a planted-WRONG wordCount. seed+broken FAILS the held-out oracle.
// The bug: it splits on a single literal space only, without trimming or collapsing runs. So "hello   world"
// counts the empty strings between spaces (3, not 2), tabs/newlines aren't separators, and "" counts as 1.
function wordCount(text) {
  return String(text).split(" ").length;
}

module.exports = { wordCount };
