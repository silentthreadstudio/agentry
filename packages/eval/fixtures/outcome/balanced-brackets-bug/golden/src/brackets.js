// GOLDEN overlay — the correct fix: a closer with an empty stack is unbalanced. seed+golden PASSES the oracle.
const PAIRS = { ")": "(", "]": "[", "}": "{" };
const OPENERS = new Set(["(", "[", "{"]);

function isBalanced(text) {
  const stack = [];
  for (const ch of String(text)) {
    if (OPENERS.has(ch)) {
      stack.push(ch);
    } else if (ch in PAIRS) {
      if (stack.length === 0 || stack.pop() !== PAIRS[ch]) {
        return false;
      }
    }
  }
  return stack.length === 0;
}

module.exports = { isBalanced };
