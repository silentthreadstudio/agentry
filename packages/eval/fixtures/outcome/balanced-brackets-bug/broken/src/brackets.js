// BROKEN overlay — a plausible-but-WRONG "fix". seed+broken FAILS the held-out oracle.
// The bug: it now guards the empty stack (so stray closers are rejected) BUT it stopped checking the bracket
// TYPE — any closer just pops the top opener. So "(a]" is wrongly accepted, failing the wrong-type-closer case.
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

function isBalanced(text) {
  const stack = [];
  for (const ch of String(text)) {
    if (OPENERS.has(ch)) {
      stack.push(ch);
    } else if (CLOSERS.has(ch)) {
      if (stack.length === 0) {
        return false;
      }
      stack.pop(); // BUG: pops without checking the opener matches this closer's type.
    }
  }
  return stack.length === 0;
}

module.exports = { isBalanced };
