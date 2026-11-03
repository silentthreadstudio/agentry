// The next free id of a kind, from its `create.id` pattern (plan F13 §2.4): `{n}` is one above the
// highest number in use, `{n:02}` the same, zero-padded. Shared by `next-id` and `add`.
//
// nextId(name, kind, model) -> { id } | { error }   error = the kind asks for its ids ("ask"), or the
// pattern needs more than a number.
const NUMBER = /\{n(?::0(\d+))?\}/;
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function nextId(name, kind, model) {
  const pattern = kind.create?.id;
  if (!pattern || pattern === "ask")
    return { error: `${name} ids are chosen by hand (create.id is "${pattern ?? "unset"}")` };
  const [token, width] = NUMBER.exec(pattern) ?? [];
  const [before, after] = token ? pattern.split(token) : [];
  if (!token || /[{}]/.test(before + after))
    return { error: `${name}: create.id "${pattern}" needs more than a number` };
  const ours = new RegExp(`^${literal(before)}(\\d+)${literal(after)}$`);
  const used = model.kinds[name].items
    .map((i) => ours.exec(i.id)?.[1])
    .filter(Boolean)
    .map(Number);
  const next = String(Math.max(0, ...used) + 1).padStart(Number(width ?? 0), "0");
  return { id: `${before}${next}${after}` };
}
