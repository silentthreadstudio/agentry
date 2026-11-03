// Process — the per-repo process file (`.agentry/process.json`, the board) and the shapes the board
// checker reports. The workflow file and the merged spec are `workflow.ts`'s. One concern: the typed contract the dependency-free checker and its hooks agree on.
// Readers and writers live in `plugin/scripts/lib/process/`, not here.
import { z } from "zod";

/** The fixed vocabulary every rule speaks; a kind maps its own status words onto these. */
export const Phase = z.enum(["planned", "active", "done", "dropped", "parked"]);
export type Phase = z.infer<typeof Phase>;

export const Field = z
  .object({
    column: z.string(),
    type: z
      .enum(["text", "list", "ref", "flag", "date", "commits", "evidence", "link", "mentions"])
      .optional(),
    ref: z.union([z.string(), z.array(z.string())]).optional(),
    prefix: z.string().optional(),
    role: z.enum(["parent", "children"]).optional(),
    also: z.array(z.string()).optional(),
    mark: z.string().optional(),
    join: z
      .string()
      .regex(/^[^0-9A-Za-z\p{Cc}]+$/u, {
        message: "a separator with no letters, digits, line breaks or control characters",
      })
      .optional(),
    match: z.string().optional(),
    case: z.literal("upper").optional(),
  })
  .strict();
export type Field = z.infer<typeof Field>;

/** Where a kind's items live: rows of a table under a heading, or one markdown file per item. */
const KindLocation = z.union([
  z.object({ table: z.string(), heading: z.string() }).strict(),
  z
    .object({
      files: z.string(),
      id: z.string().regex(/^(frontmatter:.+|filename:.*\{id\}.*)$/, {
        message: 'expected "frontmatter:<key>" or "filename:<pattern with {id}>"',
      }),
    })
    .strict(),
]);

// One object (not a union) so a bad phase reports its own path instead of the union's.
const KindStatus = z
  .object({
    field: z.string().optional(),
    values: z.record(Phase).optional(),
    derived: z.literal("children").optional(),
  })
  .strict()
  .refine((s) => (s.derived !== undefined) !== (s.field !== undefined && s.values !== undefined), {
    message: 'expected { field, values } or { derived: "children" }',
  });

const KindFile = z
  .object({
    glob: z.string(),
    required: z.boolean().optional(),
    except: z.array(z.string()).optional(),
    sections: z
      .record(
        z
          .object({
            heading: z.string(),
            as: z.enum(["table", "bold-lead"]),
            column: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const KindCreate = z
  .object({
    ask: z.array(z.string()).optional(),
    id: z.string(),
    rows: z
      .array(
        z
          .object({
            in: z.string().regex(/^(self|parent\.file:.+)$/, {
              message: 'expected "self" or "parent.file:<section>"',
            }),
            at: z.string().regex(/^(end|after-last:.+)$/, {
              message: 'expected "end" or "after-last:<field>"',
            }),
            cells: z.record(z.string()),
          })
          .strict(),
      )
      .optional(),
    blocks: z
      .array(z.object({ file: z.string(), under: z.string(), text: z.string() }).strict())
      .optional(),
  })
  .strict();

export const ProcessKind = z
  .object({
    label: z.string(),
    note: z.string().optional(),
    at: KindLocation,
    id: z
      .object({
        column: z.string().optional(),
        match: z.string().optional(),
        prefix: z.string().optional(),
      })
      .strict()
      .optional(),
    fields: z.record(Field).optional(),
    status: KindStatus.optional(),
    file: KindFile.optional(),
    contract: z
      .object({
        blocks: z.array(z.string()),
        lead: z.array(z.enum(["heading", "bold"])).optional(),
      })
      .strict()
      .optional(),
    create: KindCreate.optional(),
  })
  .strict();
export type ProcessKind = z.infer<typeof ProcessKind>;

/** A catalog rule plus its params. Params differ per rule, so extra keys pass through. */
export const Rule = z
  .object({
    rule: z.string().min(1),
    label: z.string().optional(),
    kind: z.string().optional(),
    note: z.string().optional(),
    except: z.record(z.array(z.string())).optional(),
  })
  .passthrough();
export type Rule = z.infer<typeof Rule>;

// The values the harness keys and `status` take never an empty string, and their paths stay inside the
// repository (relative to its git root): a typo refuses instead of quietly checking less. Mirrors the
// plugin's `spec/shape.mjs`; the shared table (`plugin/scripts/test/key-cases.mjs`) holds both to one verdict.
export const Text = z.string().min(1);
/** True when a repo-relative path is absolute or climbs out with `..` (posix `normalize` semantics). */
const leavesRepo = (path: string): boolean => {
  if (path.startsWith("/")) return true;
  let depth = 0;
  for (const part of path.split("/")) {
    if (part === "..") depth--;
    else if (part !== "" && part !== ".") depth++;
    if (depth < 0) return true;
  }
  return false;
};
export const RepoPath = Text.refine((p) => !leavesRepo(p), { message: "leaves the repository" });

/** The `status` key of the process file: how the derived view is built and primed. */
export const StatusConfig = z
  .object({
    now: z.string().optional(),
    note: z.string().optional(),
    prime: z.boolean().optional(),
    lines: z.number().int().positive().optional(),
    /** A hand-kept status file, and the heading in it that lists what is next. */
    file: RepoPath.optional(),
    next: Text.optional(),
  })
  .strict();
export type StatusConfig = z.infer<typeof StatusConfig>;

/** The process file (`.agentry/process.json`): the board, exactly these six keys. How the harness works
 *  the repo is the workflow file's (`workflow.ts`). */
export const ProcessBoard = z
  .object({
    version: z.literal(1),
    name: z.string(),
    root: z.string(),
    kinds: z
      .record(ProcessKind)
      .refine((kinds) => Object.keys(kinds).length > 0, "should name at least one kind"),
    rules: z.array(Rule),
    status: StatusConfig.optional(),
  })
  .strict();
export type ProcessBoard = z.infer<typeof ProcessBoard>;

/** One problem a rule (or the loader) found. */
export const Finding = z.object({
  rule: z.string(),
  label: z.string().optional(),
  kind: z.string().optional(),
  id: z.string().optional(),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
});
export type Finding = z.infer<typeof Finding>;

/** One row or file of a kind, as the reader returns it. */
export const Item = z.object({
  kind: z.string(),
  id: z.string(),
  fields: z.record(z.union([z.string(), z.array(z.string()), z.boolean(), z.null()])),
  status: z.string().optional(),
  phase: Phase.optional(),
  parent: z.string().optional(),
  children: z.array(z.string()),
  rank: z.number().optional(),
  file: z.string(),
  line: z.number().int(),
});
export type Item = z.infer<typeof Item>;

const count = z.number().int().nonnegative();

/** A "now" or "ahead" item (a sprint) and how its work items (tasks) stand. `total` leaves parked out;
 *  `tally` splits active into `verify` (the lifecycle's built status) and the rest. */
const Progress = z.object({
  kind: z.string(),
  id: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  done: count,
  total: count,
  tally: z.object({
    done: count,
    verify: count,
    active: count,
    planned: count,
    dropped: count,
    parked: count,
  }),
});

/** The derived view `board status` builds each time from the items, git and the note. */
export const StatusView = z.object({
  now: z.array(Progress).default([]),
  inFlight: z.array(z.object({ id: z.string(), status: z.string().optional() })).default([]),
  /** Work waiting on a look (verify) and open items of standalone kinds (owner questions). */
  onYou: z
    .array(z.object({ kind: z.string(), id: z.string(), status: z.string().optional() }))
    .default([]),
  /** Planned work items with a dependency that is not done. */
  blocked: z.array(z.object({ id: z.string(), by: z.array(z.string()) })).default([]),
  ahead: z.array(Progress).default([]),
  parked: count.default(0),
  recent: z.array(z.object({ sha: z.string(), subject: z.string() })).default([]),
  note: z.object({ path: z.string(), lines: z.array(z.string()) }).optional(),
});
export type StatusView = z.infer<typeof StatusView>;

/** The `board.mjs --json` output. */
export const BoardReport = z.object({
  ok: z.boolean(),
  name: z.string(),
  root: z.string(),
  rules: z.number().int(),
  items: z.record(z.number().int()),
  findings: z.array(Finding),
  status: StatusView.optional(),
});
export type BoardReport = z.infer<typeof BoardReport>;
