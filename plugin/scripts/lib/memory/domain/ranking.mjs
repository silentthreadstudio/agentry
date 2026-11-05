// Recall ranking — pure. The three orthogonal axes: relevance x confidence x usefulness.

/**
 * Recall score. `relevance` (0..1) comes from the text index; `confidence` (0..1) is how true the
 * fact is; `usefulness` (>= 0) is how often it has helped. Usefulness is damped (`1 + u`) so a fresh,
 * never-cited memory isn't zeroed out of recall before it gets a chance to prove itself.
 */
export const recallScore = (fact, relevance) => relevance * fact.confidence * (1 + fact.usefulness);
