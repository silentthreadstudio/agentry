// board next-id <kind> — the next free id from the kind's `create.id` pattern (plan F13 §2.4):
// `{n}` is one above the highest number in use, `{n:02}` the same, zero-padded. Exit 2 when the kind
// asks for its ids (`"ask"`) or the pattern needs more than a number. Writes nothing.
//
// run(argv, { spec, model }) -> { exit, out }
import { own } from "../spec.mjs";

const NUMBER = /\{n(?::0(\d+))?\}/;

export function run(argv, { spec, model }) {
  const name = argv.find((a) => !a.startsWith("--"));
  const kind = own(spec.kinds, name);
  if (!kind)
    return { exit: 2, out: `usage: next-id <kind> (kinds: ${Object.keys(spec.kinds).join(", ")})` };
  const pattern = kind.create?.id;
  if (!pattern || pattern === "ask")
    return {
      exit: 2,
      out: `${name} ids are chosen by hand (create.id is "${pattern ?? "unset"}")`,
    };
  const [token, width] = NUMBER.exec(pattern) ?? [];
  const [before, after] = token ? pattern.split(token) : [];
  if (!token || /[{}]/.test(before + after))
    return { exit: 2, out: `${name}: create.id "${pattern}" needs more than a number` };
  const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ours = new RegExp(`^${literal(before)}(\\d+)${literal(after)}$`);
  const used = model.kinds[name].items
    .map((i) => ours.exec(i.id)?.[1])
    .filter(Boolean)
    .map(Number);
  const next = String(Math.max(0, ...used) + 1).padStart(Number(width ?? 0), "0");
  return { exit: 0, out: `${before}${next}${after}` };
}
