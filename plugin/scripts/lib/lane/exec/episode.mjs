// exec/episode — the `episode_write` payload a lane's close (or its cut) prints, from its ledger alone.
import { routeText } from "../exec-view.mjs";
import { short } from "../fmt.mjs";
import { callsLine } from "../owner-calls.mjs";
import { verdicts } from "../rounds.mjs";

// The `episode_write` arguments for this lane, from the ledger alone.
const ownerHolds = (ledger) => (ledger.holds ?? []).filter((h) => h.for === "owner").length;
export function episodeOf(ledger) {
  const judged = verdicts(ledger);
  const guardTrips = ledger.rounds.flatMap((r) => r.guards ?? []);
  const lastGate = ledger.gates?.at(-1);
  const what = ledger.rounds.findLast(
    (r) => r.role === "build" && r.step !== "fix" && r.summary,
  )?.summary;
  const kept = ledger.cut?.kept ?? [];
  const outcome = [
    ledger.cut
      ? `cut on ${ledger.cut.decision}: kept ${kept.length ? `${kept.length} file(s) (${kept.slice(0, 5).join(", ")}${kept.length > 5 ? ", …" : ""})${ledger.cut.commit ? ` in ${short(ledger.cut.commit)}` : ""}` : "nothing"}`
      : ledger.state === "stopped"
        ? `stopped: ${ledger.stopReason ?? "unknown"}`
        : ledger.origin === "adopted"
          ? "adopted: not built or verified by a lane"
          : judged.length === 0
            ? "gated: no verifier read it (exec.verify)"
            : `verified (${judged.at(-1)?.verdict})`,
    `rounds: ${ledger.rounds.map((r) => `${r.step}${r.resend ? " (resent)" : ""}`).join(", ")}`,
    `verdicts: ${judged.map((r) => r.verdict).join(", ") || "none"}`,
    `void verdicts: ${ledger.rounds.filter((r) => r.void).length}`,
    `guard trips: ${guardTrips.length ? guardTrips.join(" | ") : "none"}`,
    `worktree gate: ${lastGate ? `${lastGate.exit === 0 ? "green" : "red"} ${lastGate.tier} on ${short(lastGate.commit)}` : "none"}`,
    `nested worktrees: ${ledger.nested?.length ?? 0}`,
    `verify route: ${routeText(ledger.route)}`,
    ...(ownerHolds(ledger) ? [`owner holds: ${ownerHolds(ledger)}`] : []),
    ...(callsLine(ledger) ? [callsLine(ledger)] : []),
    ...(ledger.ownerFixes?.length ? [`owner fixes: ${ledger.ownerFixes.length}`] : []),
    ...(ledger.rebases?.length ? [`rebases: ${ledger.rebases.length}`] : []),
    ...(ledger.on || ledger.restacks?.length
      ? [
          `stacked on ${ledger.on ?? ledger.restacks[0].parent}; restacks: ${ledger.restacks?.length ?? 0}`,
        ]
      : []),
    ...(ledger.openNotes?.length ? [`open notes: ${ledger.openNotes.join(" | ")}`] : []),
  ].join("; ");
  return {
    task: what ? `${ledger.id}: ${what}` : ledger.id,
    shape: "exec",
    outcome,
    retries: Math.max(0, ledger.rounds.filter((r) => r.role === "build").length - 1),
    usedMemories: ledger.usedMemories ?? [],
  };
}
