// HTTP campaign endpoint: this inbound route is the existing surface (create a campaign, inspect its
// status). The new send endpoint — the thing that renders the campaign for its audience and hands
// each message to the sender, then marks the campaign sending — registers here the same way these
// routes do.

import { allCampaigns } from "../models/campaign.js";

export function registerCampaignRoutes(router) {
  router.post("/campaigns", (req, res) => {
    res.status(201).json({ id: req.body.id, status: "draft" });
  });

  router.get("/campaigns/:id", (req, res) => {
    res.status(200).json({ id: req.params.id, status: "unknown" });
  });

  router.get("/campaigns", (req, res) => {
    res.status(200).json({ count: allCampaigns().length });
  });
}
