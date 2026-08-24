// token contrast guard (doc 19 a11y) — the palette clears WCAG AA where it carries text, and the 3:1
// non-text floor where it carries a status dot.
//
// This is a test rather than a note in tokens.css because the values drifted exactly the way a note lets
// them: the tokens were measured against `--bg` alone, and the app then put the same ink on `--panel` and
// `--raise`, where `--faint` fell to 2.68:1. The floor that matters is the LIGHTEST surface an ink ever
// sits on, so that is what this checks — one measurement, taken at the worst case, on every ink.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "tokens.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(TOKENS);
  assert.ok(m, `--${name} must be a 6-digit hex in tokens.css`);
  return m[1] as string;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Every surface an ink can land on. `--raise` is the lightest and therefore the binding constraint.
const SURFACES = ["bg", "bg2", "side-bg", "panel", "panel2", "raise"];

const TEXT = ["ink", "ink2", "muted", "faint", "accent-ink", "done", "prog", "rev", "block", "v1", "accent"];

test("every text ink clears WCAG AA (4.5:1) on every surface it can sit on", () => {
  const failures: string[] = [];
  for (const ink of TEXT) {
    for (const surface of SURFACES) {
      const ratio = contrast(token(ink), token(surface));
      if (ratio < 4.5) failures.push(`--${ink} on --${surface} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `below AA:\n  ${failures.join("\n  ")}`);
});

// `--todo` is the only palette hue that never carries text — it is the Backlog column's dot. A dot is a
// non-text graphic, so 3:1 is its floor, but it is still a floor: a status you cannot see is not a status.
test("the status-dot hue clears the 3:1 non-text floor", () => {
  for (const surface of SURFACES) {
    const ratio = contrast(token("todo"), token(surface));
    assert.ok(ratio >= 3, `--todo on --${surface} = ${ratio.toFixed(2)}:1, below the 3:1 non-text floor`);
  }
});

// The three ink tiers must stay TELLABLE APART, or the hierarchy they encode is decoration. Lifting
// --faint to clear AA nearly collapsed it into --muted; this is what stops the next lift from finishing
// the job.
test("the ink tiers stay visually distinct", () => {
  assert.ok(contrast(token("ink"), token("muted")) >= 1.8, "ink vs muted");
  assert.ok(contrast(token("muted"), token("faint")) >= 1.3, "muted vs faint");
});
