// agent-deny — every specialist agent withholds the tools that publish outward. A subagent that inherits
// them can put a report, with whatever private repo content is in it, on a page anyone with the link
// opens. The conductor runs the main session and is the one agent that may publish.
//
// agentsMissingDeny(pluginDir) -> string[]    "agents/<file>: disallowedTools does not withhold <tool>" each
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const OUTWARD = ["Artifact", "ArtifactComments", "ArtifactData"];
const MAIN_SESSION = "conductor.md";

// The entries of the `disallowedTools:` frontmatter field: a comma-separated string or a YAML list.
function denied(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const field = fm.match(/^disallowedTools:[ \t]*(.*(?:\n[ \t]+-.*)*)/m)?.[1] ?? "";
  return field
    .split(/[,\n]/)
    .map((e) => e.replace(/^\s*-/, "").trim())
    .filter(Boolean);
}

export function agentsMissingDeny(pluginDir) {
  const dir = join(pluginDir, "agents");
  const problems = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md") && n !== MAIN_SESSION)) {
    const entries = denied(readFileSync(join(dir, f), "utf8"));
    for (const tool of OUTWARD)
      if (!entries.includes(tool))
        problems.push(`agents/${f}: disallowedTools does not withhold ${tool}`);
  }
  return problems;
}
