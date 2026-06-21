# Spec — skip-flag violation (flow-compliance fixture)

An above-floor run (a FLOW run_start line is present) that nonetheless carries a
`flow-skipped` backstop marker (ADR-001 / B1): a gate artifact was written with no run.
Only check 4 (no-skip-flag) fails.
