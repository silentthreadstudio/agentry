// GOLDEN overlay — depth-aware recursion: recurse into nested arrays only while depth remains, decrementing each
// level. seed+golden PASSES the held-out oracle (the discrimination control).
function flatten(arr, depth = Infinity) {
  const out = [];
  for (const item of arr) {
    if (Array.isArray(item) && depth > 0) {
      out.push(...flatten(item, depth - 1));
    } else {
      out.push(item);
    }
  }
  return out;
}

module.exports = { flatten };
