// Template service: business logic that turns a stored template plus per-recipient variables into a
// concrete subject and body. Mirrors how other services wrap a model and produce a value. The new
// template-rendering logic (load template -> interpolate variables -> return rendered email) lives
// here.

import { getCampaign } from "../models/campaign.js";

const templates = new Map();

export function registerTemplate(id, body) {
  templates.set(id, body);
}

export function templateForCampaign(campaignId) {
  const campaign = getCampaign(campaignId);
  return campaign ? templates.get(campaign.templateId) : undefined;
}
