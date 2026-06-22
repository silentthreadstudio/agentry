// BROKEN overlay — transitions.js carries the right table, but the broken machine does not consult it per-state;
// the guard here is left as a permissive helper the broken machine ignores. The table itself is correct.
const TRANSITIONS = {
  draft: { submit: "review" },
  review: { approve: "published", reject: "draft" },
  published: { archive: "archived" },
};

function nextState(state, event) {
  const row = TRANSITIONS[state];
  return row ? row[event] : undefined;
}

module.exports = { TRANSITIONS, nextState };
