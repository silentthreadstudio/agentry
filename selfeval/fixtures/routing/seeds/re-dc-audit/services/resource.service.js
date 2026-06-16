// Resource service: business logic over the resource model. These three functions are the mutations
// that an audit log must capture. The service is where logging middleware sees each change happen.

import {
  createResource,
  updateResource,
  deleteResource,
  getResource,
  allResources,
} from "../models/resource.js";

export function addResource(input) {
  return createResource(input);
}

export function editResource(id, patch) {
  return updateResource(id, patch);
}

export function removeResource(id) {
  return deleteResource(id);
}

export function findResource(id) {
  return getResource(id);
}

export function listResources() {
  return allResources();
}
