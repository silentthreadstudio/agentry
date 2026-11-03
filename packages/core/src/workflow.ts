// Workflow — the per-repo workflow file (`.agentry/workflow.json`, optional, the sibling of the process
// file): how the harness works the repo. Every key is optional; an absent one is the default behaviour
// for it. `ProcessSpec` is the two files merged, the value the plugin's loader hands every reader.
// Mirrors the plugin's `spec/workflow.mjs`; the shared table (`plugin/scripts/test/key-cases.mjs`) holds
// both to one verdict.
import { z } from "zod";
import { ProcessBoard, RepoPath, Text } from "./process.js";

/** The harness events and the status word each one sets. */
const On = z
  .object({
    dispatched: z.string().optional(),
    built: z.string().optional(),
    failed: z.string().optional(),
    merged: z.string().optional(),
  })
  .strict();
const Writes = {
  status: z.string().optional(),
  verdict: z.string().optional(),
  commit: z.string().optional(),
};

/** What the harness writes as events arrive. Absent = the checker is read-only. */
export const Lifecycle = z
  .object({
    kind: z.string(),
    on: On,
    write: z
      .object({
        ...Writes,
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
export type Lifecycle = z.infer<typeof Lifecycle>;

/** How an answered question becomes a draft of a kind: `{ "<draft>": { kind, map } }`. */
export const Drafts = z.record(z.object({ kind: z.string(), map: z.record(z.string()) }).strict());
export type Drafts = z.infer<typeof Drafts>;

/** Worktrees that are kept on purpose: names or globs of a branch or directory, shown as kept, never drift. */
export const Worktrees = z.object({ keep: z.array(Text).min(1) }).strict();
export type Worktrees = z.infer<typeof Worktrees>;

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

const Name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, { message: "expected a name (lower-case, digits, -)" });

/** When a tier or a checklist item applies: `only` (every changed file matches; none changed never
 *  does), `any` (some changed file matches), `flag: true` (the item's flag is set). Any one holding is
 *  enough; at least one is given. */
export const When = z
  .object({ only: Globs.optional(), any: Globs.optional(), flag: z.literal(true).optional() })
  .strict()
  .refine((w) => w.only !== undefined || w.any !== undefined || w.flag !== undefined, {
    message: 'expected "only", "any" or "flag"',
  });
export type When = z.infer<typeof When>;

/** One tier of the gate: argv run with no shell in the git root of the tree under test. */
export const GateTier = z
  .object({
    name: Name.refine((n) => n !== "pick" && n !== "none", {
      message: "pick and none are gate.roles values",
    }),
    command: Argv,
    when: When.optional(),
  })
  .strict();
export type GateTier = z.infer<typeof GateTier>;

// A list whose items' `name`s are unique.
const uniqueNames = (items: { name: string }[], ctx: z.RefinementCtx) =>
  items.forEach((item, i) => {
    if (items.findIndex((x) => x.name === item.name) < i)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "name"],
        message: `repeats "${item.name}"`,
      });
  });

/** The tiers in precedence order: every tier but the last has a `when`; the last, the fallback, has
 *  none, and only it may be called `full`. */
const Tiers = z
  .array(GateTier)
  .min(1)
  .superRefine((tiers, ctx) => {
    uniqueNames(tiers, ctx);
    const last = tiers.length - 1;
    tiers.forEach((tier, i) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, path], message });
      if (tier.name === "full" && i !== last) issue("name", '"full" names the last tier only');
      if (i === last && tier.when) issue("when", "the last tier is the fallback: it takes no when");
      if (i !== last && !tier.when) issue("when", "required on every tier but the last");
    });
  });

/** A manual check the land waits on, recorded like a merge check; no `when` = every land. */
export const ChecklistItem = z.object({ name: Name, text: Text, when: When.optional() }).strict();
export type ChecklistItem = z.infer<typeof ChecklistItem>;

// What each role may name besides a tier.
const ROLE_WORDS = {
  build: ["pick", "full"],
  verify: ["pick", "full", "none"],
  merge: ["pick", "full"],
};
// A key 0.3 replaced: any value is refused, with where it goes now.
const Replaced = (message: string) => z.never({ invalid_type_error: message }).optional();

/** The repo's gate: `tiers`; `roles`, the tier each role runs (`pick` = the first tier whose `when`
 *  holds, `full` = the last tier, or a tier's name; `verify` also `none`); `checklist`, manual checks
 *  the land waits on; `after` lists the files it may leave changed; `concurrency` is how many lane gates
 *  run at once; `flaky` names tests a red may fail in and be re-run; `flakyLogs` are extra logs it reads
 *  for their names. `command` and `quick` are refused: `tiers` replaced them. */
export const Gate = z
  .object({
    tiers: Tiers,
    roles: z
      .object({
        build: z.string().optional(),
        verify: z.string().optional(),
        merge: z.string().optional(),
      })
      .strict()
      .optional(),
    checklist: z.array(ChecklistItem).min(1).superRefine(uniqueNames).optional(),
    after: Globs.optional(),
    concurrency: z.number().int().positive().optional(),
    flaky: z.array(Text).min(1).optional(),
    flakyLogs: z.array(LogGlob).min(1).optional(),
    note: Text.optional(),
    command: Replaced(
      'replaced by gate.tiers (0.3): make it the last tier, { "name": "full", "command": […] }',
    ),
    quick: Replaced('replaced by gate.tiers: a tier with "when": { "only": […] } before the last'),
  })
  .strict()
  .superRefine((gate, ctx) => {
    const names = gate.tiers.map((t) => t.name);
    for (const [role, words] of Object.entries(ROLE_WORDS)) {
      const value = gate.roles?.[role as keyof typeof ROLE_WORDS];
      if (value !== undefined && !words.includes(value) && !names.includes(value))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", role],
          message: `names no tier ("${value}"): the tiers are ${names.join(", ")}; or say ${words.join(", ")}`,
        });
    }
  });
export type Gate = z.infer<typeof Gate>;

const SkillName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, { message: "expected a skill name (lower-case, digits, -)" });

/** The repo skills a command runs as checks (native names): `/agentry:merge`'s, and the session's at
 *  `/agentry:start` and `/agentry:close`. Each phase is optional, `[]` names none; the object names one. */
const SkillChecks = z
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
  .strict();
export const Extensions = z
  .object({
    merge: SkillChecks.optional(),
    start: SkillChecks.optional(),
    close: SkillChecks.optional(),
  })
  .strict()
  .refine((e) => e.merge || e.start || e.close, {
    message: "names none of merge, start, close",
  });
export type Extensions = z.infer<typeof Extensions>;

/** The repo's conductor prompt, and the heading standing-rule appends go under. */
export const Conductor = z.object({ prompt: RepoPath, rules: Text.optional() }).strict();
export type Conductor = z.infer<typeof Conductor>;

/** Main-checkout files the main-touched guard lets change while a lane runs (globs), unless a running
 *  lane owns them. */
export const Guard = z.object({ allow: Globs }).strict();
export type Guard = z.infer<typeof Guard>;

/** Ignored files `lane merge --cleanup` discards without asking (globs, e.g. build output). */
export const Cleanup = z.object({ disposable: Globs }).strict();
export type Cleanup = z.infer<typeof Cleanup>;

/** A kind exec runs beside the lifecycle (`exec.kinds.<kind>`, e.g. debt): the lifecycle mapping with no
 *  `kind` (the key names it) and no handoff. Its kind needs no parent field; the loader checks that. */
export const ExecKind = z.object({ on: On, write: z.object(Writes).strict().optional() }).strict();
export type ExecKind = z.infer<typeof ExecKind>;

/** The exec lane's own settings: `verify` says which items get an independent verifier (`all` by default;
 *  `flagged` only those whose `flag` field is set, which needs a `flag` field on every kind exec runs);
 *  `kinds` the kinds it runs beside the lifecycle's. */
export const Exec = z
  .object({
    verify: z.enum(["all", "flagged", "none"]).optional(),
    kinds: z.record(ExecKind).optional(),
  })
  .strict();
export type Exec = z.infer<typeof Exec>;

/** The model each exec dispatch names, by role: `build`, and `verify` by the item (`ui`: a designer
 *  builds it, `flagged`: its flag is set) with `default` for the rest. Any string; all optional. */
export const Models = z
  .object({
    build: Text.optional(),
    verify: z
      .object({ default: Text.optional(), ui: Text.optional(), flagged: Text.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type Models = z.infer<typeof Models>;

/** The repo's policy for the exec briefs: one line each, at most 20 per role. `build` goes in every
 *  builder brief, `verify` in every verifier brief, printed as written under "Repo policy". */
const PolicyLine = Text.refine((line) => !/[\r\n]/.test(line), { message: "expected one line" });
const PolicyLines = z.array(PolicyLine).min(1).max(20);
export const Briefs = z
  .object({ build: PolicyLines.optional(), verify: PolicyLines.optional() })
  .strict();
export type Briefs = z.infer<typeof Briefs>;

const validRegex = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};
const Pattern = Text.refine(validRegex, { message: "expected a valid regular expression" });

/** The rules a builder's commit subjects hold to: `subjectMax` (code points), `subjectPattern` (no
 *  flags) on the first line, and `forbid` patterns (flag `m`) on the whole message. */
export const Commits = z
  .object({
    subjectMax: z.number().int().positive().optional(),
    subjectPattern: Pattern.optional(),
    forbid: z.array(Pattern).min(1).optional(),
  })
  .strict();
export type Commits = z.infer<typeof Commits>;

/** Named locks `agentry run --lock <name>` and `agentry lock take <name>` hold: each name's slots (at
 *  least 1, e.g. `{ "editor": 1 }`). One entry or more. */
export const Locks = z
  .record(Name, z.number().int().positive())
  .refine((locks) => Object.keys(locks).length > 0, { message: "expected at least one lock" });
export type Locks = z.infer<typeof Locks>;

// One `lane merge --check <name>` records a checklist item or a merge check, so no name is both.
const checklistApart = (
  w: { gate?: Gate | undefined; extensions?: Extensions | undefined },
  ctx: z.RefinementCtx,
): void =>
  (w.gate?.checklist ?? []).forEach((item, i) => {
    if (w.extensions?.merge?.checks.includes(item.name))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gate", "checklist", i, "name"],
        message: `"${item.name}" is also an extensions.merge.checks name`,
      });
  });

// The workflow file's keys, before the checks that read two of them.
const WorkflowKeys = z
  .object({
    lifecycle: Lifecycle.optional(),
    drafts: Drafts.optional(),
    worktrees: Worktrees.optional(),
    gate: Gate.optional(),
    extensions: Extensions.optional(),
    conductor: Conductor.optional(),
    guard: Guard.optional(),
    cleanup: Cleanup.optional(),
    exec: Exec.optional(),
    models: Models.optional(),
    briefs: Briefs.optional(),
    commits: Commits.optional(),
    locks: Locks.optional(),
  })
  .strict();

/** The workflow file: no `version`, every key optional, no other key. */
export const Workflow = WorkflowKeys.superRefine(checklistApart);
export type Workflow = z.infer<typeof Workflow>;

/** The loaded value: the process file's board and the workflow file's keys, merged. */
export const ProcessSpec = ProcessBoard.merge(WorkflowKeys).superRefine(checklistApart);
export type ProcessSpec = z.infer<typeof ProcessSpec>;
