/**
 * Slash-safe join of Astro's `base` (e.g. "/agentry") with an internal path.
 * Astro does NOT auto-prefix hand-written href/src — every internal asset/link
 * URL must go through this or it 404s under a sub-path base (the GH-Pages rule).
 *
 * `import.meta.env.BASE_URL` is "/agentry" or "/agentry/" depending on trailingSlash;
 * normalize both sides so we never emit "/agentryfoo" or "/agentry//foo".
 */
export function withBase(path = ""): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const rel = path.replace(/^\//, "");
  return rel ? `${base}/${rel}` : `${base}/`;
}
