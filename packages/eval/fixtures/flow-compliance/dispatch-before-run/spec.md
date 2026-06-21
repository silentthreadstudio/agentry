# Spec — dispatch-before-run violation (flow-compliance fixture)

The implementer was dispatched (`agent-started`) BEFORE any FLOW run_start line — the
proven bypass. Only check 1 (run_start-before-dispatch) fails; spec/tasks/skip are clean.
