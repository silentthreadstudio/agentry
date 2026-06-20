// http — the Node `http` request edge (ADR-001's `transport`). For every request it: (1) resolves the
// run context off the `Host` header (host-router, ADR-002); (2) delegates `/healthz` + `/api/*` to
// `routes`; (3) otherwise serves the built SPA static from `plugin/workbench/web/`, with an `index.html`
// fallback so client-side routes (`/work/<id>`, `/works`) resolve to the app shell, not a 404.
//
// Static root resolution (ADR-003): the server bundle ships at `plugin/workbench/server/index.js`, the
// web build side-by-side at `plugin/workbench/web/`. We resolve the web dir relative to the running
// bundle (`import.meta.url` → `../web`), with a `CLAUDE_PLUGIN_ROOT` override when the plugin host sets
// it. No hardcoded absolute path — the two artifacts always travel together.
//
// This module owns request shaping only; it holds no run state. The application state (the reader) and
// the run context per request are passed in by the composition root.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkReader } from "../application/work-reader.js";
import { resolveRunContext } from "./host-router.js";
import {
  handleApiRequest,
  handlePostRequest,
  handleReaderRequest,
  type ReaderDeps,
  type WriteDeps,
} from "./routes.js";

// Resolve the built SPA's static root. `CLAUDE_PLUGIN_ROOT` (set by the plugin host) wins; otherwise the
// web dir sits beside the server bundle (`<bundle>/../web`). Resolved once at module load — the layout
// is fixed for the process's lifetime.
function resolveWebRoot(): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && pluginRoot.length > 0) {
    return join(pluginRoot, "workbench", "web");
  }
  const bundleDir = fileURLToPath(new URL(".", import.meta.url));
  return resolve(bundleDir, "..", "web");
}

const WEB_ROOT = resolveWebRoot();
const INDEX_HTML = join(WEB_ROOT, "index.html");

// The minimal content-type map for a Vite build's asset graph (hashed .js/.css + index.html + the
// occasional font/image). An unknown extension falls back to octet-stream — the browser sniffs, and the
// SPA's own assets are all covered here.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

// Build the http request handler bound to the application reader (+ the Phase-3 write deps). The
// composition root attaches the returned handler to the port-locked server (`server.on("request",
// handler)`). `write` carries the WriteService + Transport the POST routes need (threaded the same way
// the reader is — task 9's DI pattern).
export function createHttpHandler(reader: WorkReader, write: WriteDeps, readers: ReaderDeps) {
  return function handler(req: IncomingMessage, res: ServerResponse): void {
    const context = resolveRunContext(req.headers.host);

    // GET API + healthz first; a matched read route answers and we're done.
    if (handleApiRequest(req, res, reader, context)) return;

    // The Phase-4 aggregation reads (events/agents/gates/tokens/memory) — a separate GET dispatcher,
    // tried before the write/static path; a matched reader route answers here.
    if (handleReaderRequest(req, res, readers)) return;

    // The write surface (POST /comment,/artifact,/takeover) consumes the request body, so it is async;
    // it answers a matched write path, otherwise falls through to static-serving below. A non-write,
    // non-GET request lands at the 405 after the (resolved-false) write dispatch.
    void handlePostRequest(req, res, write).then((handled) => {
      if (handled) return;
      // Everything else is the SPA: a real asset path serves the file; anything else falls back to the
      // app shell (client-side routing). Only GET/HEAD reach static serving.
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      serveStatic(req, res);
    });
  };
}

// Serve a static file from the web root, or fall back to index.html (the SPA shell). Path traversal is
// guarded: a resolved path that escapes the web root is rejected and folded into the index.html fallback,
// never a read outside the bundle.
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const filePath = resolveStaticFile(url.pathname);

  if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
    sendFile(req, res, filePath);
    return;
  }
  // Client-route or missing asset → the SPA shell, so the React router can take over. A genuinely
  // missing build (no index.html) is a 404 — the server is up but unbuilt.
  if (existsSync(INDEX_HTML)) {
    sendFile(req, res, INDEX_HTML);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("workbench web build not found");
}

// Map a request pathname to an on-disk file under the web root, or null when it would escape the root.
// `/` maps to index.html; any other path is normalized and contained.
function resolveStaticFile(pathname: string): string | null {
  const decoded = safeDecode(pathname);
  if (decoded === null) return null;
  if (decoded === "/" || decoded === "") return INDEX_HTML;

  // Normalize then contain: the resolved path must stay within WEB_ROOT (a `..` segment can't escape).
  const candidate = normalize(join(WEB_ROOT, decoded));
  if (candidate !== WEB_ROOT && !candidate.startsWith(WEB_ROOT + sep)) return null;
  return candidate;
}

function safeDecode(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

// Stream a file with its content-type. HEAD gets the headers without the body.
function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath)
    .on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}
