// project-seam guard (doc 19 B7) — one server, several project roots, so EVERY request has to say which
// root it means. `apiPath` stamps `?project=<slug>`; a raw `fetch` that skips it silently reads the
// server's DEFAULT project, which looks like working software right up until you have two projects open.
//
// This is a lint expressed as a test rather than a convention in a comment, because the failure is
// invisible: nothing throws, nothing 404s, you just read the wrong repo. It is a source scan for the same
// reason — there is no runtime seam to assert on, and a unit test of `apiPath` would prove the helper
// works while saying nothing about the call sites that forget it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

// `http.ts` DEFINES the seam (`fetch(apiPath(path))`), and the test dir describes it. Everything else obeys.
const EXEMPT = new Set([join(SRC, "api", "http.ts")]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test("every fetch of the local server goes through apiPath", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    if (EXEMPT.has(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?<![.\w])fetch\(\s*(.{0,12})/gs)) {
      if (m[1]?.startsWith("apiPath(") === true) continue;
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${file.slice(SRC.length + 1)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these fetch calls skip apiPath, so they read the server's default project:\n  ${offenders.join("\n  ")}`,
  );
});

// The socket carries the same seam by a different route — a query param it builds itself — because a run
// id is only unique WITHIN a project, so a socket without one can be pointed at the wrong run's events.
test("the websocket url carries the project", () => {
  const ws = readFileSync(join(SRC, "api", "ws.ts"), "utf8");
  assert.match(ws, /currentProject\(\)/, "ws.ts must read the tab's project");
  assert.match(ws, /params\.set\("project"/, "ws.ts must put the project on the socket url");
});
