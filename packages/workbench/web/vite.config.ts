import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ADR-003: the web bundle is built into the committed plugin payload at plugin/workbench/web/ (the server
// static-serves it). From this config's dir (packages/workbench/web/), the committed dist at repo
// plugin/workbench/web/ is three levels up.
//
// `base` is ABSOLUTE ("/"), not relative. It was "./" back when every page lived at the origin root (each
// run was its own `*.localhost` host), where relative asset URLs resolved fine. Under path routing a run
// is served at `/work/<slug>`, so "./assets/index.js" resolves to `/work/assets/index.js`, misses, falls
// through to the SPA's index.html fallback, and the browser refuses the HTML as a module script — a blank
// page whose only symptom is a MIME-type console error. One origin serves every route, so "/" is correct.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../../../plugin/workbench/web",
    emptyOutDir: true,
  },
});
