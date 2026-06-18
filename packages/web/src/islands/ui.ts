// ui.ts — the two trivial DOM hooks with no home of their own (VISION §6):
//   1. nav scroll-blur: toggle `.scrolled` on `[data-nav]` past ~8px scroll.
//   2. copy-to-clipboard: `[data-copy]` buttons copy `data-clipboard` and flash "Copied".
// One file by design — splitting two ~15-line DOM hooks further is over-engineering.
//
// Neither hook animates, so neither needs a reduced-motion guard; the transient
// "Copied" text swap is informational, not motion.

/** Toggle `.scrolled` on the sticky nav once the page has scrolled past the threshold. */
function initNavBlur(root: ParentNode = document): void {
  const nav = root.querySelector<HTMLElement>('[data-nav]');
  if (!nav) return;

  const THRESHOLD = 8;
  const apply = (): void => {
    nav.classList.toggle('scrolled', window.scrollY > THRESHOLD);
  };
  apply(); // reflect the initial scroll position (e.g. on reload mid-page)
  window.addEventListener('scroll', apply, { passive: true });
}

/** Copy `data-clipboard` to the clipboard and show a transient "Copied" state. */
function initCopyButtons(root: ParentNode = document): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-copy]'));
  if (buttons.length === 0) return;

  const RESTORE_MS = 1500;

  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.clipboard ?? '';
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return; // clipboard blocked (insecure context / denied) — leave the button as-is
      }

      const original = btn.dataset.copyLabel ?? btn.textContent ?? '';
      // stash once so repeated clicks during the window don't capture "Copied"
      if (btn.dataset.copyLabel === undefined) btn.dataset.copyLabel = original;

      btn.textContent = 'Copied';
      btn.setAttribute('aria-live', 'polite');
      btn.dataset.copied = 'true';

      window.setTimeout(() => {
        btn.textContent = btn.dataset.copyLabel ?? '';
        delete btn.dataset.copied;
      }, RESTORE_MS);
    });
  }
}

export function initUi(root: ParentNode = document): void {
  initNavBlur(root);
  initCopyButtons(root);
}

initUi();
