// Campaign model: an in-memory store of marketing campaigns. This is the existing domain. The new
// email-campaign model sits here — a row needs a subject, a templateId for rendering, an audience
// list, and a scheduledAt timestamp the scheduler reads.

const campaigns = new Map();

export function createCampaign({ id, name }) {
  const campaign = { id, name, status: "draft", createdAt: Date.now() };
  campaigns.set(id, campaign);
  return campaign;
}

export function getCampaign(id) {
  return campaigns.get(id);
}

export function allCampaigns() {
  return [...campaigns.values()];
}
