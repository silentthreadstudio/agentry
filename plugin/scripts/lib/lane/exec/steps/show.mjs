// exec/steps/show — `lane exec show <id>`: the ledger and the pending step, for a cold resume.
import * as ledgers from "../../../process/ledger.mjs";
import { idleMinutes, resolveWorkflow } from "../../../process/spec/presets.mjs";
import { answerLabel, restackText, routeFixedText } from "../../exec-view.mjs";
import { short } from "../../fmt.mjs";
import { idleOf } from "../../idle.mjs";
import { routeOf } from "../../rounds.mjs";
import { childrenOf } from "../../stack.mjs";
import { nestedTrees } from "../admission.mjs";
import { laneLine, mustLedger, ownedOf } from "../lane.mjs";
import { liveNotes } from "../notes.mjs";
import { answerOf, routeNow, stepCount, stepLines, view, waysOn } from "../view.mjs";

export function run(ctx, id) {
  const { root, spec } = ctx;
  const ledger = mustLedger(root, id);
  const children = childrenOf(ledgers.list(root), id);
  const idle = idleOf(ledger.worktree, ledger, Date.now(), idleMinutes(spec));
  return view(ctx, ledger, {
    step: "show",
    nested: nestedTrees(root, ledger),
    lead: {
      ...(idle && { idle: { ...idle, park: laneLine(root, "hold", id, " --for later") } }),
      ...(ledger.state === "stopped" && waysOn(root, ledger)),
    },
    extra: {
      owned: ownedOf(root, ledger),
      ...(ledger.steps && { steps: stepLines(ledger.steps) }),
      ...(ledger.holds?.length && {
        holds: ledger.holds
          .map((h) => `${answerLabel(h)}: ${answerOf(h, stepCount(ledger))}`)
          .join("\n"),
      }),
      workflow: resolveWorkflow(spec),
      "route fixed at start": routeFixedText(routeOf(ledger), liveNotes(ctx)),
      route: routeNow(ctx, ledger),
      ...(ledger.openNotes?.length && { openNotes: ledger.openNotes }),
      ...(ledger.left?.length && {
        left: ledger.left
          .map((l) => `${l.label}: left as built by the ${l.by} at ${l.at} (round ${l.round})`)
          .join("\n"),
      }),
      rounds: ledger.rounds.map((r) => ({
        n: r.n,
        step: r.step,
        mode: r.mode,
        ...(r.resend && { resend: true }),
        ...(r.agent && { agent: r.agent }),
        ...(r.status && { status: r.status }),
        ...(r.verdict && { verdict: r.verdict }),
        ...(r.void && { void: true }),
        ...(r.held && { held: true }),
        ...(r.stepRun && { stepRun: r.stepRun }),
        ...(r.guards && { guards: r.guards }),
      })),
      gates: (ledger.gates ?? []).map((g) => ({
        exit: g.exit,
        tier: g.tier,
        commit: short(g.commit),
        log: g.log,
      })),
      ...(ledger.rebases?.length && { rebases: ledger.rebases }),
      ...(ledger.restacks?.length && { restacks: ledger.restacks.map(restackText).join("\n") }),
      ...(children.length && { "stacked on it": children.join(", ") }),
      ...(ledger.episode && { episode: ledger.episode }),
    },
  });
}
