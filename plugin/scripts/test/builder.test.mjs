import assert from "node:assert/strict";
import test from "node:test";
import { suggestBuilder } from "../lib/lane/builder.mjs";

test("a script or logic file under a ui folder goes to the implementer, and the why names the override", () => {
  for (const path of [
    "src/ui/panel.gd",
    "ui/hud.ts",
    "src/components/store.js",
    "ui/a.mjs",
    "ui/b.py",
  ]) {
    const got = suggestBuilder([path]);
    assert.equal(got.agent, "implementer", path);
    assert.match(got.why, /not a UI file kind/, path);
    assert.ok(got.why.includes("`- **Agent:** designer`"), path);
  }
});

test("a UI file kind stays with the designer wherever it sits", () => {
  for (const path of ["src/ui/panel.tscn", "ui/panel.css", "src/Nav.vue", "x/index.html"])
    assert.deepEqual(suggestBuilder([path]), { agent: "designer", why: `${path} is UI-shaped` });
});

test("a folder or a glob of a ui folder still goes to the designer, a typed glob does not", () => {
  assert.equal(suggestBuilder(["src/ui/"]).agent, "designer");
  assert.equal(suggestBuilder(["ui/**"]).agent, "designer");
  assert.equal(suggestBuilder(["src/ui/*.gd"]).agent, "implementer");
});

test("the contract's Agent bullet overrides the route for a logic file under ui", () => {
  const contract = "- **T1**: owns `src/ui/panel.gd`.\n- **Agent:** designer";
  assert.deepEqual(suggestBuilder(["src/ui/panel.gd"], { contract }), {
    agent: "designer",
    why: "the contract names it",
    from: "contract",
  });
});

test("a path outside any ui folder keeps the plain implementer why", () => {
  assert.deepEqual(suggestBuilder(["src/domain/rules.ts"]), {
    agent: "implementer",
    why: "no owned path is UI-shaped",
  });
});

test("a folder visual by name is UI whatever the extension, a generic folder is not", () => {
  for (const path of ["a/Styles/x.ts", "src/css/tokens.js", "game/assets/hud.gd", "src/theme/a.py"])
    assert.equal(suggestBuilder([path]).agent, "designer", path);
  for (const path of ["src/ui/x.gd", "web/lib/x.ts", "src/views/store.js", "src/components/s.py"])
    assert.equal(suggestBuilder([path]).agent, "implementer", path);
});

test("a React file is UI inside a generic UI folder only", () => {
  for (const path of [
    "components/Button.tsx",
    "src/views/Home.jsx",
    "pages/index.tsx",
    "web/App.tsx",
  ])
    assert.equal(suggestBuilder([path]).agent, "designer", path);
  for (const path of [
    "lib/useX.tsx",
    "src/hooks/useY.jsx",
    "components/Button.ts",
    "src/ui/panel.gd",
  ])
    assert.equal(suggestBuilder([path]).agent, "implementer", path);
});
