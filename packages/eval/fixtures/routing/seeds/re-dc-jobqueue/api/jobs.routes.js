// HTTP surface: the inbound routes for the jobs service. Today there is only a health/inspection
// route; there is no enqueue endpoint yet. The new enqueue API — accept a job, hand it to the queue
// service, return its id — registers here the same way this route does.

import { count } from "../services/queue.service.js";

export function registerJobRoutes(router) {
  router.get("/jobs", (req, res) => {
    res.status(200).json({ depth: count() });
  });
}
