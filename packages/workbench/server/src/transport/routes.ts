// routes — the transport barrel. The route surface was split by concern into focused modules
// (http-kit · route-match · doc-model · read-routes · reader-routes · write-routes · permission-routes);
// this file re-exports the four dispatcher entry points + their deps types so http.ts and the route tests
// import one stable surface. Add a new route group as its own module, then re-export it here.
export { handleApiRequest } from "./read-routes.js";
export { handleReaderRequest, type ReaderDeps } from "./reader-routes.js";
export { handlePostRequest, type WriteDeps } from "./write-routes.js";
export { handlePermissionRequest, type PermissionDeps } from "./permission-routes.js";
