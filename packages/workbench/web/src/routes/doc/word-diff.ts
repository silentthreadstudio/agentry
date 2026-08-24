// word-diff — a tiny token-level diff for the before/after panes (task 19). Computes the longest common
// subsequence of whitespace-delimited tokens between two markdown bodies and emits a flat op stream
// (`equal` / `del` / `add`) the DiffDrawer paints (struck-through removals on the left, highlighted
// additions on the right), matching prototype-document.html's `.del` / `.add` treatment.
//
// Pure and dependency-free (no `diff` npm package): the bodies it diffs are short doc sections, so an
// O(n·m) LCS table is well within budget and keeps the bundle lean (the repo bar: no new lib without a
// decision). It tokenizes on whitespace so word-level edits show as word changes, not whole-line churn —
// and it is fed `normalize(body)` for both sides (task 14) so the diff is clean, not serializer noise.

export type DiffOp =
  | { kind: "equal"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string };

// Split into tokens that KEEP their trailing whitespace, so re-joining the ops reproduces the text
// exactly (no lost spaces/newlines). Each token is "word + following whitespace run".
function tokenize(text: string): string[] {
  const tokens = text.match(/\S+\s*|\s+/g);
  return tokens ?? [];
}

/**
 * Diff two bodies at the token level. Returns the op stream left-to-right: `equal` runs are shared,
 * `del` runs are only in `before`, `add` runs are only in `after`.
 */
export function wordDiff(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const lcs = lcsTable(a, b);

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(ops, "equal", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push(ops, "del", a[i]!);
      i++;
    } else {
      push(ops, "add", b[j]!);
      j++;
    }
  }
  while (i < a.length) push(ops, "del", a[i++]!);
  while (j < b.length) push(ops, "add", b[j++]!);
  return ops;
}

/** True when the two bodies are token-identical (no diff to show). */
export function isUnchanged(before: string, after: string): boolean {
  return before === after;
}

// LCS length DP table: lcs[i][j] = length of the LCS of a[i:] and b[j:]. Built bottom-up.
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  return lcs;
}

// Coalesce consecutive ops of the same kind so the painted spans are runs, not per-token fragments.
function push(ops: DiffOp[], kind: DiffOp["kind"], text: string): void {
  const last = ops[ops.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  ops.push({ kind, text } as DiffOp);
}
