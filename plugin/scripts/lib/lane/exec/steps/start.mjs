// exec/steps/start — `lane exec start <id>`: a lane's checks, then the lane opened (`open-lane`).
import { unknownCites } from "../../brief.mjs";
import { refuseAtWriterCap, refuseLane, refuseMidLand } from "../admission.mjs";
import { refuse } from "../lane.mjs";
import { contractOf, mainBranchOf, openLane, stackParent } from "../open-lane.mjs";

export function run(ctx, id) {
  const { root, spec, model, cite } = ctx;
  const unknown = unknownCites({ spec, model, cite });
  if (unknown.length) refuse(`--cite names no decision on the board: ${unknown.join(", ")}`);
  refuseLane(root, id);
  refuseMidLand(root);
  const parent = ctx.on === null ? null : stackParent(ctx, id);
  refuseAtWriterCap(root, spec);
  const found = contractOf(ctx, id);
  return openLane(ctx, id, { found, parent, mainBranch: mainBranchOf(root) });
}
