// exec/steps/cut — `lane exec cut <id> --decision <D>`: a lane retired on a board decision
// (`cut.mjs`).
import { cutLane } from "../../cut.mjs";
import { episodeOf } from "../episode.mjs";
import { Stopped, laneLine, mustLedger, refuse } from "../lane.mjs";

export const run = (ctx, id) =>
  cutLane(ctx, id, {
    ledger: mustLedger(ctx.root, id),
    refuse,
    stop: (message) => {
      throw new Stopped(message);
    },
    laneLine,
    episodeOf,
  });
