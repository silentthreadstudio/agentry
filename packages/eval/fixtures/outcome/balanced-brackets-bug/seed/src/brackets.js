// isBalanced(text) — true iff every ()[]{} bracket is matched and correctly nested.
//
// PLANTED BUG: when a CLOSING bracket arrives, the code only checks the top of the stack IF the stack is
// non-empty (`if (stack.length)`). A closer with an empty stack is silently ignored, so "a)" and "(a)b)" wrongly
// return true. The seed is a working-but-wrong impl (it does not throw). The agent must reject the empty-stack
// case. The well-formed cases all behave correctly.
const PAIRS = { ")": "(", "]": "[", "}": "{" };
const OPENERS = new Set(["(", "[", "{"]);

function isBalanced(text) {
  const stack = [];
  for (const ch of String(text)) {
    if (OPENERS.has(ch)) {
      stack.push(ch);
    } else if (ch in PAIRS) {
      // BUG: should fail when the stack is empty; instead it skips the check entirely.
      if (stack.length) {
        if (stack[stack.length - 1] !== PAIRS[ch]) {
          return false;
        }
        stack.pop();
      }
    }
  }
  return stack.length === 0;
}

module.exports = { isBalanced };
