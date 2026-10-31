// Process — the per-repo process file (`.agentry/process.json`) and the shapes the board checker
// reports. One concern: the typed contract the dependency-free checker, its hooks and (later) the
// Workbench all agree on. Readers and writers live in `plugin/scripts/lib/process/`, not here.
import { z } from "zod";

/** The fixed vocabulary every rule speaks; a kind maps its own status words onto these. */
export const Phase = z.enum(["planned", "active", "done", "dropped", "parked"]);
export type Phase = z.infer<typeof Phase>;

export const Field = z
  .object({
    column: z.string(),
    type: z.enum(["text", "list", "ref", "flag", "date", "commits", "evidence", "link"]).optional(),
    ref: z.union([z.string(), z.array(z.string())]).optional(),
    role: z.enum(["parent", "children"]).optional(),
    also: z.array(z.string()).optional(),
    mark: z.string().optional(),
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

/** What the harness writes as events arrive. Absent = the checker is read-only. */
const Lifecycle = z
  .object({
    kind: z.string(),
    on: z
      .object({
        dispatched: z.string().optional(),
        built: z.string().optional(),
        failed: z.string().optional(),
        merged: z.string().optional(),
      })
      .strict(),
    write: z.record(z.string()).optional(),
    handoff: z.string().optional(),
  })
  .strict();

const Drafts = z.record(z.object({ kind: z.string(), map: z.record(z.string()) }).strict());

/** The `status` key of the process file: how the derived view is built and primed. */
export const StatusConfig = z
  .object({
    now: z.string().optional(),
    note: z.string().optional(),
    prime: z.boolean().optional(),
    lines: z.number().int().positive().optional(),
  })
  .strict();
export type StatusConfig = z.infer<typeof StatusConfig>;

export const ProcessSpec = z
  .object({
    version: z.literal(1),
    name: z.string(),
    root: z.string(),
    kinds: z.record(ProcessKind),
    rules: z.array(Rule),
    lifecycle: Lifecycle.optional(),
    drafts: Drafts.optional(),
    status: StatusConfig.optional(),
  })
  .strict();
export type ProcessSpec = z.infer<typeof ProcessSpec>;

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

/** The derived view `board status` builds each time from items, git, worktrees, drafts and the note. */
export const StatusView = z.object({
  now: z
    .array(
      z.object({
        kind: z.string(),
        id: z.string(),
        name: z.string().optional(),
        status: z.string().optional(),
        done: z.number().int().optional(),
        total: z.number().int().optional(),
        waiting: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  inFlight: z
    .array(
      z.object({ id: z.string(), status: z.string().optional(), worktree: z.string().optional() }),
    )
    .default([]),
  verify: z.array(z.string()).default([]),
  next: z.array(z.string()).default([]),
  blocked: z.array(z.object({ id: z.string(), by: z.array(z.string()) })).default([]),
  drafts: z.number().int().default(0),
  recent: z.array(z.object({ sha: z.string(), subject: z.string() })).default([]),
  note: z.object({ path: z.string(), lines: z.number().int() }).optional(),
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
