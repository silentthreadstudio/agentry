// projects proof (M1) — the multi-project seam: slug derivation, `?project=` resolution, and the
// `/api/projects` list/register surface.
//
// What this pins down is a defect that was SILENT: the port is a global singleton but the served root
// used to be fixed at spawn, so the first repo to start the Workbench owned it and every later
// `/agentry:workbench` focused a server showing another repo's runs under the wrong name. A project must
// therefore be (a) explicitly named per request, (b) resolvable to exactly one root, and (c) a 404 when
// it names nothing — never a silent fall-back to somebody else's project.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { slugsFor } from "../src/application/project.js";
import type { Project } from "../src/application/project.js";
import { type ProjectSource, handleProjectsRequest, runKey } from "../src/transport/projects.js";

function fakeProject(slug: string, root: string): Project {
  return { slug, root } as unknown as Project;
}

function fakeRes(): { res: ServerResponse; captured: { status: number; body: unknown } } {
  const captured = { status: 0, body: undefined as unknown };
  let raw = "";
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      captured.body = raw.length > 0 ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

const fakeReq = (url: string, method = "GET"): IncomingMessage =>
  ({ url, method, headers: {} }) as unknown as IncomingMessage;

function source(projects: Project[], registered: string[] = []): ProjectSource {
  return {
    list: () => projects,
    resolve: (slug) =>
      slug === null || slug.length === 0 ? projects[0] : projects.find((p) => p.slug === slug),
    register: (root) => {
      registered.push(root);
      const added = fakeProject("added", root);
      projects.push(added);
      return added;
    },
  };
}

test("slugsFor names each root by its basename", () => {
  const slugs = slugsFor(["/a/agentry", "/b/lifeos"]);
  assert.equal(slugs.get("/a/agentry"), "agentry");
  assert.equal(slugs.get("/b/lifeos"), "lifeos");
});

test("slugsFor disambiguates two roots that share a basename", () => {
  const slugs = slugsFor(["/one/web", "/two/web"]);
  const a = slugs.get("/one/web");
  const b = slugs.get("/two/web");
  assert.notEqual(a, b);
  assert.ok(a?.startsWith("web-"));
  assert.ok(b?.startsWith("web-"));
});

test("slugsFor is order-independent — a slug depends on the path, not the position", () => {
  const forward = slugsFor(["/one/web", "/two/web"]);
  const reverse = slugsFor(["/two/web", "/one/web"]);
  assert.equal(forward.get("/one/web"), reverse.get("/one/web"));
});

test("runKey scopes a run to its project (two projects may hold the same run id)", () => {
  assert.notEqual(runKey("agentry", "M7"), runKey("lifeos", "M7"));
});

test("GET /api/projects lists what the server serves, default first", () => {
  const { res, captured } = fakeRes();
  const projects = [fakeProject("agentry", "/a/agentry"), fakeProject("lifeos", "/b/lifeos")];
  const handled = handleProjectsRequest(
    fakeReq("/api/projects"),
    res,
    new URL("http://x/api/projects"),
    source(projects),
  );
  assert.equal(handled, true);
  assert.deepEqual(captured.body, {
    projects: [
      { slug: "agentry", root: "/a/agentry" },
      { slug: "lifeos", root: "/b/lifeos" },
    ],
    default: "agentry",
  });
});

test("a path other than /api/projects is not claimed by this dispatcher", () => {
  const { res } = fakeRes();
  assert.equal(
    handleProjectsRequest(fakeReq("/api/works"), res, new URL("http://x/api/works"), source([])),
    false,
  );
});

test("resolve falls back to the default only when NO project is named", () => {
  const s = source([fakeProject("agentry", "/a"), fakeProject("lifeos", "/b")]);
  assert.equal(s.resolve(null)?.slug, "agentry");
  assert.equal(s.resolve("lifeos")?.slug, "lifeos");
  // The load-bearing case: an explicitly named project that does not exist must NOT silently become
  // the default — that is exactly the cross-project contamination this work exists to kill.
  assert.equal(s.resolve("ghost"), undefined);
});
