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
      .regex(/^[^0-9A-Za-z]+$/, { message: "a separator with no letters or digits" })
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
    write: z
      .object({
        status: z.string().optional(),
        verdict: z.string().optional(),
        commit: z.string().optional(),
        handoff: z
          .string()
          .regex(/^parent\.file:.+$/, { message: 'expected "parent.file:<section>"' })
          .optional(),
      })
      .strict()
      .optional(),
    handoff: z.string().optional(),
  })
  .strict();

// The harness keys never take an empty string or list, and their paths stay inside the repository
// (relative to its git root): a typo refuses instead of quietly checking less. Mirrors the plugin's
// `spec.mjs`; the shared table (`plugin/scripts/test/key-cases.mjs`) holds both to one verdict.
const Text = z.string().min(1);
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
const RepoPath = Text.refine((p) => !leavesRepo(p), { message: "leaves the repository" });
/** A log glob from the gate's cwd, or from the temp directory after a literal `$TMPDIR/`. */
const LogGlob = Text.refine(
  (p) => {
    const rest = p.startsWith("$TMPDIR/") ? p.slice("$TMPDIR/".length) : p;
    return (
      rest !== "" && !rest.startsWith("/") && !rest.split("/").some((x) => x === ".." || x === ".")
    );
  },
  { message: "expected a glob from the gate's cwd or $TMPDIR/" },
);
const Argv = z.array(Text).min(1);
const Globs = z.array(RepoPath).min(1);

/** The repo's gate: argv run with no shell in the git root of the tree under test. `quick` applies
 *  only when every changed file matches `only`; `after` lists the files it may leave changed;
 *  `concurrency` is how many lane gates run at once; `flaky` names tests a red may fail in and be re-run; `flakyLogs` are extra logs it reads for their names. */
export const Gate = z
  .object({
    command: Argv,
    quick: z.object({ command: Argv, only: Globs }).strict().optional(),
    after: Globs.optional(),
    concurrency: z.number().int().positive().optional(),
    flaky: z.array(Text).min(1).optional(),
    flakyLogs: z.array(LogGlob).min(1).optional(),
    note: Text.optional(),
  })
  .strict();
export type Gate = z.infer<typeof Gate>;

const SkillName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, { message: "expected a skill name (lower-case, digits, -)" });

/** The repo skills `/agentry:merge` runs as checks (native names); `[]` names none. */
export const Extensions = z
  .object({
    merge: z
      .object({
        checks: z.array(SkillName).superRefine((names, ctx) =>
          names.forEach((name, i) => {
            if (names.indexOf(name) < i)
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [i],
                message: `repeats "${name}"`,
              });
          }),
        ),
      })
      .strict(),
  })
  .strict();
export type Extensions = z.infer<typeof Extensions>;

/** The repo's conductor prompt, and the heading standing-rule appends go under. */
export const Conductor = z.object({ prompt: RepoPath, rules: Text.optional() }).strict();
export type Conductor = z.infer<typeof Conductor>;

const Drafts = z.record(z.object({ kind: z.string(), map: z.record(z.string()) }).strict());

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

/** Worktrees that are kept on purpose: names or globs of a branch or directory, shown as kept, never drift. */
export const Worktrees = z.object({ keep: z.array(Text).min(1) }).strict();
export type Worktrees = z.infer<typeof Worktrees>;

/** Main-checkout files the main-touched guard lets change while a lane runs (globs), unless a running
 *  lane owns them. */
export const Guard = z.object({ allow: Globs }).strict();
export type Guard = z.infer<typeof Guard>;

/** Ignored files `lane merge --cleanup` discards without asking (globs, e.g. build output). */
export const Cleanup = z.object({ disposable: Globs }).strict();
export type Cleanup = z.infer<typeof Cleanup>;

export const ProcessSpec = z
  .object({
    version: z.literal(1),
    name: z.string(),
    root: z.string(),
    kinds: z
      .record(ProcessKind)
      .refine((kinds) => Object.keys(kinds).length > 0, "should name at least one kind"),
    rules: z.array(Rule),
    lifecycle: Lifecycle.optional(),
    drafts: Drafts.optional(),
    status: StatusConfig.optional(),
    worktrees: Worktrees.optional(),
    gate: Gate.optional(),
    extensions: Extensions.optional(),
    conductor: Conductor.optional(),
    guard: Guard.optional(),
    cleanup: Cleanup.optional(),
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
