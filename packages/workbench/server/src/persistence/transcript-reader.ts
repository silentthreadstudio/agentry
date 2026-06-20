// TranscriptReader — read-only access to Claude Code session transcripts (the `TranscriptSource` port,
// ADR-001). The Tokens chart's least-pinned source (plan §7.3): the on-disk transcript shape is owned by
// Claude Code, not by us, so this adapter VERIFIES the location/shape on every read and DEGRADES GRACEFULLY
// to no samples when the source is absent or unreadable — an empty `TokenSeries` is acceptable for V1. It
// never throws and never guesses.
//
// ── The on-disk contract (verified against ~/.claude/projects on 2026-06-19) ──────────────────────────
//   - Transcripts live at  ~/.claude/projects/<project-slug>/<session-id>.jsonl  (one file per session).
//   - The <project-slug> is the absolute project root with every non-alphanumeric char replaced by `-`
//     (e.g. /Users/x/agentry → -Users-x-agentry). Confirmed against the live tree.
//   - Each line is a JSON object; an ASSISTANT line carries a top-level `timestamp` (ISO) and
//     `message.usage` with `{ input_tokens, output_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens }`. We sum those four into the per-line token cost.
//   - A run maps to its session(s) via FLOW's session→run pointers
//     (`<cwd>/.agentry/run/sessions/<session-id>.json` → `{ workId }`); we invert that to find the
//     sessions for a run, then read each session's transcript. No pointer ⇒ no transcript ⇒ empty series.
//
// If any of the above drifts (a renamed dir, a changed usage shape), the reader reads zero samples and the
// chart shows a clean empty state — the documented graceful degrade, never a crash.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenSample, TranscriptSource } from "../domain/ports.js";

export class TranscriptReader implements TranscriptSource {
  // `cwd` (the project root) locates the FLOW session pointers; `home` is the transcript root base
  // (injectable so the reader is testable against a fixture tree without touching the real home dir).
  constructor(
    private readonly cwd: string,
    private readonly home: string = homedir(),
  ) {}

  // The token-usage samples observed for one run, in time order. Resolves the run's sessions from the FLOW
  // pointers, reads each session transcript, sums the per-line usage, and sorts by timestamp. An absent
  // pointer dir, an absent transcript dir, or an unreadable file each degrade to fewer (or zero) samples —
  // never a throw.
  read(run: string): TokenSample[] {
    const sessions = this.sessionsForRun(run);
    if (sessions.length === 0) return [];

    const dir = this.transcriptDir();
    if (dir === null || !existsSync(dir)) return []; // source absent — clean empty series (graceful degrade)

    const samples: TokenSample[] = [];
    for (const session of sessions) {
      const file = join(dir, `${session}.jsonl`);
      if (!existsSync(file)) continue;
      samples.push(...this.readTranscript(file));
    }
    return samples.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // Invert the FLOW session→run pointers: every `<cwd>/.agentry/run/sessions/<session>.json` whose
  // `workId` is this run names a session whose transcript belongs to the run. A missing pointer dir, an
  // unreadable pointer, or one with no matching `workId` simply contributes no session.
  private sessionsForRun(run: string): string[] {
    const dir = join(this.cwd, ".agentry", "run", "sessions");
    if (!existsSync(dir)) return [];
    const sessions: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ptr = JSON.parse(readFileSync(join(dir, file), "utf8"));
        if (ptr && typeof ptr === "object" && (ptr as Record<string, unknown>).workId === run) {
          sessions.push(file.slice(0, -".json".length));
        }
      } catch {
        // unreadable / bad-JSON pointer — skip it, never fatal
      }
    }
    return sessions;
  }

  // Read one session transcript into samples. Each assistant line with a `message.usage` becomes one
  // sample: its `timestamp` + the sum of the four token fields. A line that doesn't parse, has no usage,
  // or no timestamp is skipped — the stream stays readable past a malformed entry.
  private readTranscript(file: string): TokenSample[] {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out: TokenSample[] = [];
    for (const line of text.split("\n")) {
      const sample = parseUsageLine(line);
      if (sample !== null) out.push(sample);
    }
    return out;
  }

  // The transcript dir for this project: ~/.claude/projects/<project-slug>/, where the slug is the
  // absolute cwd with every non-alphanumeric char replaced by `-` (Claude Code's layout). Returns null
  // only if the base projects dir is itself absent (Claude Code never ran) — a degrade signal.
  private transcriptDir(): string | null {
    const base = join(this.home, ".claude", "projects");
    if (!existsSync(base)) return null;
    return join(base, projectSlug(this.cwd));
  }
}

// Parse one transcript line into a `TokenSample`, or null when it carries no usable usage. Tolerant: a
// non-JSON line, a non-assistant line, or one missing `timestamp`/`message.usage` returns null (skip).
function parseUsageLine(line: string): TokenSample | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const timestamp = raw.timestamp;
  const message = raw.message;
  if (typeof timestamp !== "string" || !isRecord(message)) return null;
  const usage = message.usage;
  if (!isRecord(usage)) return null;

  const tokens =
    num(usage.input_tokens) +
    num(usage.output_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens);
  if (tokens === 0) return null; // a line that reports zero usage carries no signal
  return { timestamp, tokens };
}

// Claude Code's project-slug rule: the absolute path with every non-alphanumeric char replaced by `-`.
function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
