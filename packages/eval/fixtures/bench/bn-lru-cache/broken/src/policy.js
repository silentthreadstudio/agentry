// GOLDEN overlay — the LRU victim is the FRONT of the recency order (least recently used). PURE. seed+golden PASSES.
function lruVictim(orderedKeys) {
  return orderedKeys[0];
}

module.exports = { lruVictim };
