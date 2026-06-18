// tasks.ts — the typed TASKS data for the RoutingDemo island (VISION §6.2).
// Pure data, no I/O. Consumed by RoutingDemo.ts and (for the server-rendered
// fallback) by components/RoutingDemo.astro.
//
// Each task teaches the "least process that wins" idea: a one-line fix routes to
// one-shot, an under-specified "make X better" routes to spec-first, a multi-file
// feature routes to decompose+verify. Honest, concrete, on-message (VISION §8) —
// these mirror the kind of work Agentry actually conducts in this repo.

/** The three routing shapes Agentry picks between, lightest → heaviest. */
export type Shape = 'one-shot' | 'spec-first' | 'decompose';

/** One routing example for the demo: a task, the shape it routes to, why, and the trace. */
export interface Task {
  /** Stable id (used as the tab key / data attribute). */
  id: string;
  /** Short tab label. */
  label: string;
  /** The task as a user would phrase it to /agentry:go. */
  prompt: string;
  /** The routed shape — the least process that wins. */
  shape: Shape;
  /** One-line rationale for the route. */
  reason: string;
  /** The conductor's reasoning trace, step by step. */
  trace: string[];
}

export const TASKS = [
  {
    id: 'fix',
    label: 'One-line fix',
    prompt: 'The date formatter drops the timezone — fix it.',
    shape: 'one-shot',
    reason: 'Single symbol, reversible, no design fork — straight to the implementer in debugging mode.',
    trace: [
      'Classify: one-symbol bug fix, no contract seam.',
      'No ambiguity, no decision to gate — skip spec & plan.',
      'Dispatch implementer: reproduce → fix → regression test.',
      'Verify against the repro; done.',
    ],
  },
  {
    id: 'improve',
    label: 'Make X better',
    prompt: 'Make the onboarding flow better.',
    shape: 'spec-first',
    reason: '"Better" has no definition of done — write the Spec and gate it before building.',
    trace: [
      'Classify: under-specified goal — "done = X" is unclear.',
      'Dispatch product-owner: job-to-be-done, non-goals, observable ACs.',
      'Gate the Spec with the user before any code.',
      'Then route the now-bounded work to its least shape.',
    ],
  },
  {
    id: 'feature',
    label: 'Multi-file feature',
    prompt: 'Add pagination to the users endpoint across API, service, and data layers.',
    shape: 'decompose',
    reason: 'Several modules with seams between them — plan the boundaries, then build in parallel and verify.',
    trace: [
      'Classify: multi-file with contract seams across layers.',
      'Dispatch architect: Plan + bounded Task contracts.',
      'Split into parallel-safe tasks (disjoint owned files).',
      'Implement each, then verify the assembled whole.',
    ],
  },
  {
    id: 'unknown',
    label: 'Unknown API',
    prompt: "Add OAuth login — figure out which flow we should use for an SPA.",
    shape: 'spec-first',
    reason: 'A real unknown gates the design — research it, then spec the chosen flow before building.',
    trace: [
      'Classify: a decision blocked on external knowledge.',
      'Dispatch researcher: verify the current best-practice flow, cited.',
      'Fold findings into a Spec; gate the chosen approach.',
      'Build on fact, not assumption.',
    ],
  },
  {
    id: 'docs',
    label: 'Doc tweak',
    prompt: 'Add a Node ≥ 24 note to the install section of the README.',
    shape: 'one-shot',
    reason: 'A small, bounded prose edit to one file — no plan, no gate.',
    trace: [
      'Classify: single-file copy edit, low blast radius.',
      'No fork, no acceptance ambiguity.',
      'Dispatch implementer: edit the section, keep the repo voice.',
      'Verify it reads clean; done.',
    ],
  },
] as const satisfies readonly Task[];
