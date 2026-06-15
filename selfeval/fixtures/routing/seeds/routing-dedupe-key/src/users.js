// User records carry BOTH a stable `id` AND an `email`. The two call sites below treat identity
// DIFFERENTLY — one keys on `id`, the other matches by case-insensitive email — so what counts as a
// "duplicate" is genuinely undecided.

export const users = [
  { id: 1, email: "ada@example.com", name: "Ada" },
  { id: 2, email: "Ada@Example.com", name: "Ada L." }, // same email (case-folded), different id
  { id: 3, email: "grace@example.com", name: "Grace" },
];

// Call site A: identity is the numeric `id`. Two records with the same id are the same user.
export function findById(list, id) {
  return list.find((u) => u.id === id);
}

// Call site B: identity is the email, compared case-insensitively. Two records whose emails match
// when lower-cased are treated as the same user here.
export function findByEmail(list, email) {
  const needle = email.toLowerCase();
  return list.find((u) => u.email.toLowerCase() === needle);
}
