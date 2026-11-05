// builder — which builder an exec round suggests: the agent the run's step marker names, else the
// contract's `**Agent:**` bullet, else designer when an owned path is UI-shaped, else implementer. A
// suggestion: the conductor decides. Pure.
import { bulletOf } from "../process/spec/models.mjs";
import { runMark } from "../process/steps.mjs";

const UI_DIRS = new Set([
  "ui",
  "components",
  "screens",
  "views",
  "pages",
  "styles",
  "theme",
  "themes",
]);
// A glob under one of these names a whole front end (`web/**`), where a plain file there may be anything.
const FRONT_DIRS = new Set(["web", "app", "ui"]);
const UI_EXT = /\.(css|scss|sass|less|vue|svelte|astro|html|tscn)$/i;

const AGENTS = ["designer", "implementer"];

/** Which builder to suggest: the first step of the run (`stepRun` of `steps`) naming an agent, `{ agent,
 *  why, from: "step N" }`, else the contract's `- **Agent:** <designer|implementer>`, `from: "contract"`,
 *  else what the owned paths suggest, `{ agent, why }`. A suggestion: the conductor decides. */
export function suggestBuilder(owned, { contract = "", steps = [], stepRun = null } = {}) {
  const step = runMark(steps, stepRun, "agent");
  if (step) return { agent: step.value, why: `${step.from} names it`, from: step.from };
  const named = bulletOf(contract, "agent")?.toLowerCase();
  if (AGENTS.includes(named))
    return { agent: named, why: "the contract names it", from: "contract" };
  const ui = owned.find((path) => {
    const parts = path.toLowerCase().split("/");
    return (
      UI_EXT.test(path) ||
      parts.some((part) => UI_DIRS.has(part)) ||
      (/[*?]/.test(path) && parts.slice(0, -1).some((part) => FRONT_DIRS.has(part)))
    );
  });
  return ui
    ? { agent: "designer", why: `${ui} is UI-shaped` }
    : { agent: "implementer", why: "no owned path is UI-shaped" };
}
