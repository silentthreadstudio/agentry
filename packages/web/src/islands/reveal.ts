// reveal.ts — scroll-reveal helper (VISION §5 motion).
// Adds `.in` to `.reveal` elements when they enter the viewport, with a small
// per-element stagger (via `data-reveal-delay`, else nth-of-appearance). The CSS
// base (.reveal → .in transition) lives in global.css; this only toggles the class.
//
// Self-initializes on load over every `.reveal`; no-ops if none are present.
// Reduced-motion: adds `.in` immediately to all (also covered by the global CSS
// off-switch, but we set it here too so there is never a flash of hidden content
// if the observer is skipped).

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Default per-step stagger (ms) when an element has no explicit data-reveal-delay. */
const STEP_MS = 70;

function revealNow(el: HTMLElement): void {
  el.classList.add('in');
}

export function initReveal(root: ParentNode = document): void {
  const targets = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
  if (targets.length === 0) return;

  if (REDUCED || typeof IntersectionObserver === 'undefined') {
    targets.forEach(revealNow);
    return;
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const attr = el.dataset.revealDelay;
        // Explicit delay wins; otherwise stagger siblings revealed in the same batch.
        const delay =
          attr !== undefined ? Number(attr) : entries.indexOf(entry) * STEP_MS;
        window.setTimeout(() => revealNow(el), Number.isFinite(delay) ? delay : 0);
        obs.unobserve(el);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.1 },
  );

  for (const el of targets) observer.observe(el);
}

initReveal();
