// Identity helpers — pure, no I/O. Every FLOW write targets `.agentry/work/<run>/…`, so a run id
// (and a task number) must be a single, traversal-safe path segment. `assertSafeSegment` is the
// shared guard mirroring the binder/emitter hooks' `..`/`/`/`\` checks (ADR-005 §4 — harden both
// ends of the shared-file seam); `mintRun` and `runDir` both route through it.

// Reject anything that could escape a single path segment. Mirrors the guard the work-id-binder and
// subagent-emit hooks already apply to the pointer's `workId` (ADR-005). Empty/whitespace is also a
// misuse — a blank segment is not a valid run/task folder.
export function assertSafeSegment(s: string): void {
  if (s.length === 0 || s.trim().length === 0) {
    throw new Error("unsafe path segment: empty");
  }
  if (s.includes("..") || s.includes("/") || s.includes("\\")) {
    throw new Error(`unsafe path segment: "${s}" contains a traversal sequence (.. / \\)`);
  }
}

// Lowercase, hyphenated, ascii-word slug of a free-text goal — the human-readable half of a run id.
// Collapses everything that isn't [a-z0-9] to a single hyphen and trims leading/trailing hyphens, so
// the result is always a clean single segment (no separators, no traversal). Kept TERSE on purpose:
// just the first few words of the goal, so `.agentry/work/<run>/` folders and their `*.localhost`
// subdomains stay short and legible — the `-<shortId()>` suffix carries uniqueness, not the stem.
const STEM_WORDS = 3; // first ~2-3 hyphen-words of the goal
const STEM_MAX = 20; // hard cap on the stem length, before the suffix
function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, STEM_WORDS);
  // Trim whole words off the tail until the stem fits the cap — never cut mid-word (a partial word
  // reads as noise), and never leave a trailing hyphen.
  while (words.length > 1 && words.join("-").length > STEM_MAX) {
    words.pop();
  }
  return words.join("-").slice(0, STEM_MAX).replace(/-+$/g, "");
}

// A short, collision-resistant id suffix (base36) — enough entropy to disambiguate two runs minted
// for the same goal without a heavyweight ulid dependency (FLOW run ids are scratch, not addresses).
function shortId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// Mint a run id from a goal: `slug(goal)-<shortid>`, a single traversal-safe path segment. When the
// goal slugs to nothing (e.g. all punctuation), fall back to a bare "run" stem so the id is never
// just the suffix. The result is asserted safe before it leaves this function.
export function mintRun(goal: string): string {
  const stem = slug(goal) || "run";
  const run = `${stem}-${shortId()}`;
  assertSafeSegment(run);
  return run;
}

// Zero-padded task number (NNN) — the stable sort/lookup prefix of a task file (`NNN-*.md`).
export function formatTaskNo(n: number): string {
  return String(n).padStart(3, "0");
}
