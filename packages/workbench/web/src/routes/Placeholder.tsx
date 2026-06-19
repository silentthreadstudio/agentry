// Placeholder — the calm "coming in this view" body for the secondary pages this task only scaffolds
// (Agents / Tokens / Memory / Gates are Phase 4). One component, parameterized by name + line, so the
// router's named slots exist now and Phase 4 swaps each body in without touching the shell.
import { EmptyState } from "../design-system/index.js";

export function Placeholder({ title, line }: { title: string; line: string }) {
  return (
    <div className="page">
      <EmptyState title={title}>{line}</EmptyState>
    </div>
  );
}
