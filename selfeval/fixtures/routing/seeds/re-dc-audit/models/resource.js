// Resource model: an in-memory store whose mutations (create/update/delete) are exactly the events an
// audit log would record. An audit-event model would sit alongside this one, with its own shape.

const resources = new Map();

export function createResource({ id, name, ownerId }) {
  const resource = { id, name, ownerId, updatedAt: Date.now() };
  resources.set(id, resource);
  return resource;
}

export function updateResource(id, patch) {
  const current = resources.get(id);
  if (!current) return undefined;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  resources.set(id, next);
  return next;
}

export function deleteResource(id) {
  return resources.delete(id);
}

export function getResource(id) {
  return resources.get(id);
}

export function allResources() {
  return [...resources.values()];
}
