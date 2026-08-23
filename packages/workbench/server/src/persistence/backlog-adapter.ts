// BacklogAdapter — the project's backlog, reachable from the Workbench.
//
// Same reuse discipline as `run-starter.ts` (ADR-005 tier 1 / ADR-007): it does NOT re-implement the
// backlog, it constructs FLOW's own `BacklogService` over this project's root, so an item created from
// the board and one created through `backlog_add` in a session are byte-identical on disk.
import { BacklogService } from "@agentry/flow/application/backlog-service";
import { RunService } from "@agentry/flow/application/run-service";
import type { Clock } from "../domain/ports.js";
import { createFlowServices } from "./flow-services.js";

export class BacklogAdapter {
  readonly service: BacklogService;

  constructor(root: string, clock: Clock) {
    const services = createFlowServices(root);
    this.service = new BacklogService(services.backlog, new RunService(services), () => clock.now());
  }
}
