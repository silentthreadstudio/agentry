// What a kind must have for a rule to check it at all. A rule declares it as `needs` on a kind param
// (or on a field param: of the kinds that field refs), and `spec.mjs` refuses a kind that lacks it:
// a rule run on a kind without a status, a parent or children would check nothing and print OK.
//
// CAN: name -> { says(of), has(kinds, name, of) }. `kinds` is the process file's (unchecked: any
// value may be garbage), `name` the kind tested, `of` the rule's own kind (for a kind named beside it,
// such as members-listed's `member`). Each mirrors what `read.mjs` derives: phases from `status`, the
// tree from `role` fields of the type it links by, ranks from the kinds a parent field refs. PURE.

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const kindOf = (kinds, name) => (Object.hasOwn(kinds, name) ? kinds[name] : undefined);
const fieldsOf = (kind) => (isObject(kind?.fields) ? Object.values(kind.fields) : []);
const refsOf = (field) => [field?.ref ?? []].flat().filter((k) => typeof k === "string");
const STARTED = ["active", "done"];
const CLOSED = ["done", "dropped", "parked"];

/** The type `read.mjs` links each role by: a parent is one id (a string), children a list. A role
 *  field of another type, or one that refs no kind, links nothing. */
export const LINK = { parent: "ref", children: "list" };
const withRole = (kind, role) =>
  fieldsOf(kind).filter(
    (f) => isObject(f) && f.role === role && f.type === LINK[role] && refsOf(f).length > 0,
  );

/** True when items of `child` hang under items of `parent`: the child's parent field refs it, or
 *  the parent's children list does (`read.mjs` builds the tree from both). */
const under = (kinds, parent, child) =>
  withRole(kindOf(kinds, child), "parent").some((f) => refsOf(f).includes(parent)) ||
  withRole(kindOf(kinds, parent), "children").some((f) => refsOf(f).includes(child));
const childKinds = (kinds, name) =>
  Object.keys(kinds).filter((k) => k !== name && under(kinds, name, k));

/** The phases a kind's items can be in: its status values, or what a derived status yields from its
 *  children's phases (none when no child kind has a status: its items are then always "planned"). */
export function phasesOf(kinds, name, seen = new Set()) {
  const kind = kindOf(kinds, name);
  if (kind?.status?.derived !== "children")
    return isObject(kind?.status?.values) ? Object.values(kind.status.values) : [];
  if (seen.has(name)) return [];
  seen.add(name);
  const child = childKinds(kinds, name).flatMap((k) => phasesOf(kinds, k, seen));
  if (child.length === 0) return [];
  const can = (phases) => child.some((p) => phases.includes(p));
  return ["planned", ...(can(STARTED) ? ["active"] : []), ...(can(CLOSED) ? ["done"] : [])];
}
const canBe =
  (...phases) =>
  (kinds, name) =>
    phasesOf(kinds, name).some((p) => phases.includes(p));

// The kinds a parent field refs rank by row order; a kind linked to one takes its rank.
const ordered = (kinds) =>
  new Set(Object.values(kinds).flatMap((k) => withRole(k, "parent").flatMap(refsOf)));
const linkedTo = (kinds, name) =>
  Object.keys(kinds).filter((k) => k !== name && (under(kinds, k, name) || under(kinds, name, k)));

export const CAN = {
  done: { says: () => 'a status that can be "done"', has: canBe("done") },
  started: {
    says: () => 'a status that can be started ("active" or "done")',
    has: canBe("active", "done"),
  },
  active: { says: () => 'a status that can be "active"', has: canBe("active") },
  parked: { says: () => 'a status that can be "parked"', has: canBe("parked") },
  "status-field": {
    says: () => "a status field of its own (a derived status is done only once its children are)",
    has: (kinds, name) => typeof kindOf(kinds, name)?.status?.field === "string",
  },
  parent: {
    says: () => 'a field with role "parent"',
    has: (kinds, name) => withRole(kindOf(kinds, name), "parent").length > 0,
  },
  // A kind with no parent field at all is `parent`'s to report, not this one's.
  "parent-status": {
    says: () => "a parent kind with a status",
    has: (kinds, name) => {
      const parents = withRole(kindOf(kinds, name), "parent").flatMap(refsOf);
      return parents.length === 0 || parents.some((k) => phasesOf(kinds, k).length > 0);
    },
  },
  children: {
    says: () => "children (another kind whose parent field refs it, or a children list)",
    has: (kinds, name) => childKinds(kinds, name).length > 0,
  },
  child: {
    says: (of) => `a parent field that refs ${of}, or a place in a children list of ${of}`,
    has: (kinds, name, of) => name !== of && under(kinds, of, name),
  },
  file: {
    says: () => 'its own file ("file")',
    has: (kinds, name) => isObject(kindOf(kinds, name)?.file),
  },
  order: {
    says: () => "an order (it, its parent or its children sit in a kind a parent field refs)",
    has: (kinds, name) => {
      const ranked = ordered(kinds);
      return ranked.has(name) || linkedTo(kinds, name).some((k) => ranked.has(k));
    },
  },
};

/** The capabilities of `needs` that kind `name` lacks, as `says` words; `of` as in CAN. */
export const lacks = (kinds, name, needs = [], of = name) =>
  needs.filter((c) => !CAN[c].has(kinds, name, of)).map((c) => CAN[c].says(of));
