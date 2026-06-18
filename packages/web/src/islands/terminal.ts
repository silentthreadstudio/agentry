// terminal.ts — typing-terminal helper (VISION §5 motion).
// Types the `data-cmd` command into the prompt, then reveals the pre-rendered
// `[data-term-line]` output children one at a time.
//
// Markup contract (emitted by Hero, T5):
//   <div data-terminal data-cmd='/agentry:go "…"'>
//     <span data-term-cmd></span>          <!-- typed into; optional, else created -->
//     <span data-term-line>output line 1</span>
//     <span data-term-line>output line 2</span>
//   </div>
// Output lines start hidden (CSS: [data-term-line] { opacity:0 }) and get `.in`.
//
// Self-initializes over every `[data-terminal]`; no-ops if none present.
// Reduced-motion: shows the full command + all lines immediately (no typing).
// The blinking cursor is CSS-driven (a `.cursor` element); CSS pauses it under
// reduced-motion via the global off-switch.

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Per-character typing interval (ms). */
const TYPE_MS = 42;
/** Pause after the command finishes typing, before lines reveal (ms). */
const PRE_REVEAL_MS = 360;
/** Gap between revealed output lines (ms). */
const LINE_MS = 220;

interface TerminalParts {
  cmdEl: HTMLElement;
  cursor: HTMLElement | null;
  lines: HTMLElement[];
}

function resolveParts(root: HTMLElement): TerminalParts {
  // Use an explicit command slot if present, else create one as the first child.
  let cmdEl = root.querySelector<HTMLElement>('[data-term-cmd]');
  if (!cmdEl) {
    cmdEl = document.createElement('span');
    cmdEl.dataset.termCmd = '';
    root.prepend(cmdEl);
  }
  return {
    cmdEl,
    cursor: root.querySelector<HTMLElement>('[data-term-cursor]'),
    lines: Array.from(root.querySelectorAll<HTMLElement>('[data-term-line]')),
  };
}

function showAll(cmd: string, parts: TerminalParts): void {
  parts.cmdEl.textContent = cmd;
  for (const line of parts.lines) line.classList.add('in');
}

function revealLines(lines: HTMLElement[], i = 0): void {
  if (i >= lines.length) return;
  lines[i].classList.add('in');
  window.setTimeout(() => revealLines(lines, i + 1), LINE_MS);
}

function typeCommand(cmd: string, parts: TerminalParts): void {
  let i = 0;
  function tick(): void {
    parts.cmdEl.textContent = cmd.slice(0, i);
    i += 1;
    if (i <= cmd.length) {
      window.setTimeout(tick, TYPE_MS);
    } else {
      window.setTimeout(() => revealLines(parts.lines), PRE_REVEAL_MS);
    }
  }
  tick();
}

function runTerminal(root: HTMLElement): void {
  const cmd = root.dataset.cmd ?? '';
  const parts = resolveParts(root);

  if (REDUCED) {
    showAll(cmd, parts);
    return;
  }

  // Defer the typing until the terminal is on screen, so it doesn't run
  // (and finish) above the fold before the user ever sees it.
  if (typeof IntersectionObserver === 'undefined') {
    typeCommand(cmd, parts);
    return;
  }
  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.disconnect();
        typeCommand(cmd, parts);
      }
    },
    { threshold: 0.5 },
  );
  observer.observe(root);
}

export function initTerminal(root: ParentNode = document): void {
  const terminals = Array.from(root.querySelectorAll<HTMLElement>('[data-terminal]'));
  if (terminals.length === 0) return;
  for (const t of terminals) runTerminal(t);
}

initTerminal();
