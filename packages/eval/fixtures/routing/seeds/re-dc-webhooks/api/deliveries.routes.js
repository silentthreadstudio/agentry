// HTTP delivery endpoint: the outbound side performs the POST to a subscriber's targetUrl; this
// inbound route is the existing surface (register a subscription, inspect delivery status). The new
// delivery endpoint — the thing that actually sends a signed payload to the subscriber and records
// the response — registers here the same way these routes do.

import { dispatchEvent } from "../services/dispatch.service.js";

export function registerWebhookRoutes(router) {
  router.post("/events", (req, res) => {
    const planned = dispatchEvent(req.body);
    res.status(202).json({ scheduled: planned.length });
  });

  router.get("/deliveries/:id", (req, res) => {
    res.status(200).json({ id: req.params.id, status: "unknown" });
  });
}
