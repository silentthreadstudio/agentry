// Queue service: business logic over the job model. Today it only stores a record and reports how
// many exist — there is no enqueue contract (no job type/payload validation, no "next pending job"
// pull for a worker to claim). The enqueue API and the worker would both build on this service.

import { insert, all } from "../models/job.js";

export function add(payload) {
  return insert(payload);
}

export function count() {
  return all().length;
}
