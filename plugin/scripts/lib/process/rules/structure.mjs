// Structure rules (ids, statuses, references, sprint files) plus the helpers every rule file shares.
// Pure: reads the Model only. See the pinned Rule/Finding/Model seams in the process-kit design.
// Each rule declares its `params` (see `index.mjs`); the process file is checked against them.

export const STARTED = new Set(["active", "done"]);
export const CLOSED = new Set(["done", "dropped", "parked"]);

// The params most rules share: the kind they check (required) and the items they skip.
export const KIND = { type: "kind", required: true };
export const EXCEPT = { type: "except" };

export function param(params, name) {
  if (params[name] === undefined) throw new Error(`missing param '${name}'`);
  return params[name];
}

export function kindSpec(model, kind) {
  if (!Object.hasOwn(model.spec.kinds, kind)) throw new Error(`unknown kind '${kind}'`);
  return model.spec.kinds[kind];
}

export function itemsOf(model, kind) {
  if (!Object.hasOwn(model.kinds, kind)) throw new Error(`unknown kind '${kind}'`);
  return model.kinds[kind].items;
}

// `except` is { field: [values] }; the field name "id" means the item's own id.
export function excepted(item, except = {}) {
  return Object.entries(except).some(([field, values]) => {
    const value = field === "id" ? item.id : item.fields[field];
    return [value].flat().some((v) => values.includes(v));
  });
}

export function scope(model, params) {
  return itemsOf(model, param(params, "kind")).filter((item) => !excepted(item, params.except));
}

export function finding(rule, item, message) {
  return { rule, kind: item.kind, id: item.id, message, file: item.file, line: item.line };
}

/** The items with this id, any kind (the board's own words never reach a built-in such as `constructor`). */
export const withId = (model, id) => (Object.hasOwn(model.index, id) ? model.index[id] : []);

export const refKinds = (field) => [field?.ref].flat().filter(Boolean);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// What a field-typed param needs of the field it names (`is` in its declaration): `fits(field, kind)`
// tests a field's declaration, `kind` being the kind the rule checks; `says(kind)` words it.
export const FIELD = {
  deps: {
    says: (kind) => `a list field whose ref includes ${kind}`,
    fits: (f, kind) => isObject(f) && f.type === "list" && refKinds(f).includes(kind),
  },
  refs: {
    says: () => "a list field with a ref",
    fits: (f) => isObject(f) && f.type === "list" && refKinds(f).length > 0,
  },
  commits: {
    says: () => "a commits or evidence field",
    fits: (f) => isObject(f) && (f.type === "commits" || f.type === "evidence"),
  },
  flag: { says: () => "a flag field", fits: (f) => isObject(f) && f.type === "flag" },
  text: { says: () => "a text field", fits: (f) => isObject(f) && (f.type ?? "text") === "text" },
  date: { says: () => "a date field", fits: (f) => isObject(f) && f.type === "date" },
};

// The items an id names, in the first of `kinds` (the field's `ref` order) that has it: an id shared by
// two kinds (a milestone and a sprint both called "M1") reads as the kind the field lists first.
export function resolve(model, id, kinds) {
  const hits = withId(model, id);
  for (const kind of kinds) {
    const found = hits.filter((item) => item.kind === kind);
    if (found.length) return found;
  }
  return [];
}

export function parentOf(model, item) {
  const fields = Object.values(model.spec.kinds[item.kind].fields ?? {});
  const field = fields.find((f) => f.role === "parent");
  return item.parent && field ? resolve(model, item.parent, refKinds(field))[0] : undefined;
}

// The field listing dependencies: params.field, else the first list that points back at the kind.
export function depField(model, params) {
  if (params.field) return params.field;
  const fields = Object.entries(kindSpec(model, param(params, "kind")).fields ?? {});
  const found = fields.find(([, f]) => FIELD.deps.fits(f, params.kind));
  if (!found) throw new Error("no dependency field (set 'field')");
  return found[0];
}

export const show = (item) => item.status ?? item.phase;

const plain = (text) =>
  String(text ?? "")
    .replace(/[*`]/g, "")
    .trim();

// The ids a bold lead names: `A`, `A/B`, `A merged` all yield tokens containing the id.
export const leadTokens = (lead) =>
  plain(lead)
    .split(/[\s/,&+;]+/)
    .filter(Boolean);

const idsUnique = {
  id: "ids-unique",
  params: {},
  check(model) {
    const out = [];
    for (const [kind, { items }] of Object.entries(model.kinds)) {
      const seen = new Set();
      for (const item of items) {
        if (seen.has(item.id)) out.push(finding("ids-unique", item, `${kind} id listed twice`));
        seen.add(item.id);
      }
    }
    return out;
  },
};

const statusKnown = {
  id: "status-known",
  params: {},
  check(model) {
    const out = [];
    for (const [kind, { items }] of Object.entries(model.kinds)) {
      const values = model.spec.kinds[kind].status?.values;
      if (!values) continue;
      for (const item of items) {
        if (Object.hasOwn(values, item.status ?? "")) continue;
        out.push(finding("status-known", item, `unknown status '${item.status ?? ""}'`));
      }
    }
    return out;
  },
};

const refsResolve = {
  id: "refs-resolve",
  params: {},
  check(model) {
    const out = [];
    for (const [kind, { items }] of Object.entries(model.kinds)) {
      const refs = Object.entries(model.spec.kinds[kind].fields ?? {}).filter(([, f]) => f.ref);
      for (const item of items) {
        for (const [name, field] of refs) {
          for (const value of [item.fields[name]].flat()) {
            if (!value || field.also?.includes(value)) continue;
            const hits = resolve(model, value, refKinds(field));
            if (hits.length === 0) {
              out.push(finding("refs-resolve", item, `${name} '${value}' is not on the board`));
            } else if (hits.length > 1) {
              const what = `${name} '${value}' matches more than one ${hits[0].kind}`;
              out.push(finding("refs-resolve", item, what));
            }
          }
        }
      }
    }
    return out;
  },
};

const fileRequired = {
  id: "file-required",
  params: { kind: { type: "kind" }, except: EXCEPT },
  check(model, params) {
    const required = (k) => model.spec.kinds[k].file?.required;
    const kinds = params.kind ? [params.kind] : Object.keys(model.kinds).filter(required);
    const out = [];
    for (const kind of kinds) {
      const file = model.spec.kinds[kind].file;
      for (const item of itemsOf(model, kind)) {
        if (excepted(item, params.except) || file?.except?.includes(item.id)) continue;
        const matches = item.own?.matches ?? [];
        if (matches.length > 1) {
          const glob = file.glob.replaceAll("{id}", item.id);
          const what = `more than one file matches ${glob}: ${matches.join(", ")}`;
          out.push(finding("file-required", item, what));
        } else if (!item.own) {
          out.push(finding("file-required", item, `no file (${file?.glob ?? "none declared"})`));
        }
      }
    }
    return out;
  },
};

// Ids a file section lists: the `column` cell of each table row, plus every token of each bold lead.
function listedIds(section, column) {
  const rows = (section.rows ?? []).map((row) =>
    plain(Object.hasOwn(row, column) ? row[column] : ""),
  );
  const leads = (section.leads ?? []).flatMap((l) => leadTokens(l.lead));
  return new Set([...rows, ...leads].filter(Boolean));
}

const membersListed = {
  id: "members-listed",
  params: {
    kind: KIND,
    section: { type: "section", of: "kind", required: true },
    member: { type: "kind", required: true },
    except: EXCEPT,
  },
  check(model, params) {
    const section = param(params, "section");
    const members = itemsOf(model, param(params, "member"));
    const column = kindSpec(model, params.kind).file?.sections?.[section]?.column;
    const out = [];
    for (const item of scope(model, params)) {
      if (!item.own) continue;
      const listed = listedIds(item.own.sections[section] ?? {}, column);
      const onBoard = new Set(members.filter((m) => m.parent === item.id).map((m) => m.id));
      for (const id of onBoard) {
        if (listed.has(id)) continue;
        out.push(
          finding(
            "members-listed",
            item,
            `${id} is in ${item.id} on the board but not in its file`,
          ),
        );
      }
      for (const id of listed) {
        if (onBoard.has(id)) continue;
        out.push(
          finding(
            "members-listed",
            item,
            `${id} is in the file of ${item.id} but not on the board there`,
          ),
        );
      }
    }
    return out;
  },
};

export const rules = [idsUnique, statusKnown, refsResolve, fileRequired, membersListed];
