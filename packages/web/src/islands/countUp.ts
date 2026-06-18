// countUp.ts — count-up KPI helper (VISION §5 motion).
// Animates an element's number from 0 → `data-to` on first view (easeOutCubic),
// honouring `data-prefix` / `data-suffix` / `data-decimals`. Uses an
// IntersectionObserver so the count starts when the KPI scrolls in.
//
// Markup contract (emitted by Kpi.astro / Hero, T5):
//   <span data-countup data-to="98" data-suffix="%" data-decimals="0"></span>
//
// Self-initializes over every `[data-countup]`; no-ops if none present.
// Reduced-motion: writes the final formatted value immediately, no animation.

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Total animation duration (ms). */
const DURATION_MS = 1400;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function format(el: HTMLElement, value: number): string {
  const decimals = Number(el.dataset.decimals ?? '0');
  const prefix = el.dataset.prefix ?? '';
  const suffix = el.dataset.suffix ?? '';
  const fixed = Number.isFinite(decimals) ? Math.max(0, decimals) : 0;
  return `${prefix}${value.toFixed(fixed)}${suffix}`;
}

function animate(el: HTMLElement, to: number): void {
  const start = performance.now();
  function frame(now: number): void {
    const t = Math.min((now - start) / DURATION_MS, 1);
    el.textContent = format(el, to * easeOutCubic(t));
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = format(el, to); // pin the exact final value
  }
  requestAnimationFrame(frame);
}

export function initCountUp(root: ParentNode = document): void {
  const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-countup]'));
  if (targets.length === 0) return;

  const to = (el: HTMLElement): number => {
    const n = Number(el.dataset.to);
    return Number.isFinite(n) ? n : 0;
  };

  if (REDUCED || typeof IntersectionObserver === 'undefined') {
    for (const el of targets) el.textContent = format(el, to(el));
    return;
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        animate(el, to(el));
        obs.unobserve(el);
      }
    },
    { threshold: 0.4 },
  );

  for (const el of targets) {
    el.textContent = format(el, 0); // avoid a flash of unstyled/empty content
    observer.observe(el);
  }
}

initCountUp();
