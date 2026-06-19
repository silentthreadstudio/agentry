import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ADR-003: the web bundle is built into the committed plugin payload at plugin/workbench/web/ (the server
// static-serves it), and `base: './'` makes every asset URL relative so it resolves behind any `*.localhost`
// host the local server is reached on. From this config's dir (packages/workbench/web/), the committed dist
// at repo plugin/workbench/web/ is three levels up.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../../plugin/workbench/web",
    emptyOutDir: true,
  },
});
