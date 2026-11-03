// /site.webmanifest — name, colours from the tokens, and the icons. An endpoint (not a static
// file) so the icon URLs follow the configured base path and carry the icon version.
import type { APIRoute } from "astro";
import { withBase } from "../lib/base.ts";
import { SITE_NAME, THEME_COLOR, iconQuery } from "../lib/site.ts";

const icon = (file: string, size: number, purpose: "any" | "maskable") => ({
  src: withBase(file) + iconQuery,
  sizes: `${size}x${size}`,
  type: "image/png",
  purpose,
});

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      {
        name: SITE_NAME,
        short_name: SITE_NAME,
        description: "The harness around Claude Code.",
        start_url: withBase(""),
        scope: withBase(""),
        display: "browser",
        theme_color: THEME_COLOR,
        background_color: THEME_COLOR,
        icons: [
          icon("icon-192.png", 192, "any"),
          icon("icon-512.png", 512, "any"),
          icon("icon-maskable-512.png", 512, "maskable"),
        ],
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/manifest+json" } },
  );
