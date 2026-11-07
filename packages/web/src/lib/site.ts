/**
 * site.ts — the facts the head, the manifest and the structured data share, in one place so
 * they cannot drift apart. Every claim here is true of the plugin today; change it with the
 * plugin, not on a whim.
 */

/** Bump when the mark changes: icon URLs carry it so browsers drop the old cached icon. */
export const ICON_VERSION = "2";

/** The paper token (`--paper` in tokens.css): the theme and manifest background colour. */
export const THEME_COLOR = "#eef0f2";

export const SITE_NAME = "Agentry";

/** The default meta description (≤ 160 characters). */
export const SITE_DESCRIPTION =
  "Agentry is the harness around Claude Code (OpenCode in development). It sizes the process to the task, runs your board as verified lanes and keeps local memory.";

export const REPO_URL = "https://github.com/silentthreadstudio/agentry";
export const PUBLISHER = { name: "Silent Thread", url: "https://silentthreadstudio.com" };

/** The install lines, as the docs install page gives them. */
export const INSTALL_COMMANDS = [
  "/plugin marketplace add silentthreadstudio/agentry#v0.3.0",
  "/plugin install agentry@agentry-dev",
  "/agentry:init",
] as const;

/** Versioned icon URL query, e.g. "?v=2". */
export const iconQuery = `?v=${ICON_VERSION}`;
