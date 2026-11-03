// Workflow — the per-repo workflow file (`.agentry/workflow.json`, optional, the sibling of the process
// file): how the harness works the repo. Every key is optional; an absent one is the default behaviour
// for it. `ProcessSpec` is the two files merged, the value the plugin's loader hands every reader.
// Mirrors the plugin's `spec/workflow.mjs`; the shared table (`plugin/scripts/test/key-cases.mjs`) holds
// both to one verdict.
import { z } from "zod";
import { ProcessBoard, RepoPath, Text } from "./process.js";

/** What the harness writes as events arrive. Absent = the checker is read-only. */
export const Lifecycle = z
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

/** Main-checkout files the main-touched guard lets change while a lane runs (globs), unless a running
 *  lane owns them. */
export const Guard = z.object({ allow: Globs }).strict();
export type Guard = z.infer<typeof Guard>;

/** Ignored files `lane merge --cleanup` discards without asking (globs, e.g. build output). */
export const Cleanup = z.object({ disposable: Globs }).strict();
export type Cleanup = z.infer<typeof Cleanup>;

/** The exec lane's own settings: `verify` says which items get an independent verifier (`all` by default;
 *  `flagged` only those whose `flag` field is set, which needs a `flag` field on the lifecycle kind). */
export const Exec = z.object({ verify: z.enum(["all", "flagged", "none"]).optional() }).strict();
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

/** The workflow file: no `version`, every key optional, no other key. */
export const Workflow = z
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
  })
  .strict();
export type Workflow = z.infer<typeof Workflow>;

/** The loaded value: the process file's board and the workflow file's keys, merged. */
export const ProcessSpec = ProcessBoard.merge(Workflow);
export type ProcessSpec = z.infer<typeof ProcessSpec>;
