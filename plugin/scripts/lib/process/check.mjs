// Model x enabled rules -> Finding[]. Pure; the only outside reach is ctx.hasCommit, used by evidence rules.
import { ruleOf, withDefaults } from "./rules/index.mjs";

// `entries` are the process file's rules ({ rule, label?, kind?, ...params }); `ctx` is { hasCommit(sha) }.
// A rule that cannot run (unknown id, missing param) becomes a finding, never a throw. The process
// file's own check (`spec.mjs`) has already refused an entry its rule does not declare.
export function check(model, entries, ctx) {
  return entries.flatMap((entry) => {
    let found;
    try {
      const rule = ruleOf(entry.rule);
      if (!rule) throw new Error("unknown rule");
      found = rule.check(model, withDefaults(rule, entry), ctx);
    } catch (error) {
      found = [
        { rule: entry.rule, kind: entry.kind, message: `rule cannot run: ${error.message}` },
      ];
    }
    return entry.label ? found.map((f) => ({ ...f, label: entry.label })) : found;
  });
}
