// exec/board — a lane's lifecycle writes on the board (`applyEvent`), each with the content ids it
// moved every file from and to: the writes the main guard follows (`boardWrites` in the ledger).
import { applyEvent } from "../../process/lifecycle.mjs";
import { contentOf } from "./guard/snapshot.mjs";
import { boardFiles } from "./guard/stray.mjs";

// One lifecycle event on item `id` of the lane's kind (`ctx.kind`), and what it did to each file as
// `{ file, from, to }` content ids: the writes the main guard follows (`boardWrites` in the ledger).
export function boardEvent(ctx, event, id, data) {
  const { root, spec, model, kind } = ctx;
  const before = contentOf(root, boardFiles(spec, model, id, kind));
  const board = applyEvent({ root, spec, model, event, id, kind, data });
  const files = [...new Set(board.writes.map((w) => w.file))];
  const after = contentOf(root, files);
  return { board, moves: files.map((file) => ({ file, from: before[file], to: after[file] })) };
}

// Built is written once, when the item goes to a verifier, or straight to the gate when none reads it:
// never at a hold, a resume that carries on building, or a run's end before the last step. Returns
// what the lifecycle wrote, and records its moves in `ledger`.
export function writeBuilt(ctx, ledger, res) {
  const next =
    ["verify", "recheck"].includes(res.dispatch?.step) || ["gate", "close"].includes(res.next);
  if (!next) return null;
  const built = boardEvent(ctx, "built", ledger.id);
  ledger.boardWrites = [...(ledger.boardWrites ?? []), ...built.moves];
  return built.board;
}
