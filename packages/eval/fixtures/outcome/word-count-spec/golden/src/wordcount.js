// GOLDEN overlay — a known-correct wordCount. seed+golden PASSES the held-out oracle.
function wordCount(text) {
  const trimmed = String(text).trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

module.exports = { wordCount };
