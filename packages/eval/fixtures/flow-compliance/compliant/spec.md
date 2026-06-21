# Spec — compliant escalated run (flow-compliance fixture)

A synthetic above-floor run that satisfies the ordered Flow-compliance contract:
run_start fired before dispatch, spec written before tasks, each task carries one
frontmatter block, and no `flow-skipped` marker was emitted.

## Acceptance
- The probe returns PASS over this run dir.
