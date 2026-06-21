/**
 * docs-nav.ts — the single source of truth for the /docs information architecture
 * (ADR-005). The grouped sidebar, every page's active-state key, and the prev/next
 * sequencing all read from the one ordered structure here. Adding a page = one entry.
 *
 * Hrefs are stored BARE ("docs/quickstart"); callers render them through withBase()
 * so they resolve under the /agentry sub-path (the #1 base-path 404 trap). Never
 * hand-write the base prefix here.
 */

/** The closed route-key enum every docs page binds to (overview = /docs index, no key). */
export type DocsKey =
  | "quickstart"
  | "install"
  | "why"
  | "when"
  | "capabilities"
  | "flow"
  | "memory"
  | "workbench"
  | "channels"
  | "permissions"
  | "evals"
  | "security"
  | "changelog"
  | "troubleshooting";

export interface DocsItem {
  /** Stable route key — matches a page's `current` prop for active state. */
  key: DocsKey;
  /** Sidebar label. */
  label: string;
  /** BARE internal path, e.g. "docs/quickstart" — render via withBase(). */
  href: string;
}

export interface DocsGroup {
  /** Section heading shown above the group in the sidebar. */
  title: string;
  items: DocsItem[];
}

/** The overview sits above the groups; it is the /docs index, keyless. */
export const DOCS_OVERVIEW = { label: "Overview", href: "docs" } as const;

/** The IA, in reading order — drives the sidebar AND prev/next sequencing. */
export const docsGroups: DocsGroup[] = [
  {
    title: "Getting Started",
    items: [
      { key: "quickstart", label: "Quickstart", href: "docs/quickstart" },
      { key: "install", label: "Install", href: "docs/install" },
      { key: "why", label: "Why Agentry", href: "docs/why" },
      { key: "when", label: "When to use it", href: "docs/when" },
    ],
  },
  {
    title: "Capabilities",
    items: [
      { key: "capabilities", label: "Overview", href: "docs/capabilities" },
      { key: "flow", label: "Flow", href: "docs/flow" },
      { key: "memory", label: "Memory", href: "docs/memory" },
      { key: "workbench", label: "Workbench", href: "docs/workbench" },
      { key: "channels", label: "Channels", href: "docs/channels" },
      { key: "permissions", label: "Permissions", href: "docs/permissions" },
    ],
  },
  {
    title: "Reference",
    items: [
      { key: "evals", label: "Self-Eval", href: "docs/evals" },
      { key: "security", label: "Security", href: "docs/security" },
      { key: "changelog", label: "Changelog", href: "docs/changelog" },
      { key: "troubleshooting", label: "Troubleshooting", href: "docs/troubleshooting" },
    ],
  },
];

/** Flat, ordered list of every keyed item — used for prev/next sequencing. */
export const docsSequence: DocsItem[] = docsGroups.flatMap((g) => g.items);

/** The prev/next neighbours of a page (null at the ends). */
export function docsNeighbours(current: DocsKey): {
  prev: DocsItem | null;
  next: DocsItem | null;
} {
  const i = docsSequence.findIndex((it) => it.key === current);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? docsSequence[i - 1] : null,
    next: i < docsSequence.length - 1 ? docsSequence[i + 1] : null,
  };
}
