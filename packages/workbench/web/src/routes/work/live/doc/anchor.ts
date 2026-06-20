// anchor — the 3-way-anchor builder for a span comment (task 18). Given the rendered prose root and the
// browser Range of a selection, it produces the `ReviewAnchor` FLOW stores and re-locates a comment with
// after the document drifts (spec §3.1 / AC10):
//   • originalText  — the exact selected snippet,
//   • headingAnchor — the nearest `##`-level section heading at or above the selection,
//   • startLine     — the 1-based body line the selection starts on (block index in the rendered prose).
//
// Split in two: a PURE core (`computeAnchor`) over a tiny block model, and a thin DOM adapter
// (`buildAnchor`) that reads that model off the live `.ProseMirror` element. The split keeps the
// heading-walk / line logic unit-testable without a DOM (the adapter is trivial structure-reading).
import type { ReviewAnchor } from "./review-types.js";

/** A rendered block as the anchor logic sees it — the tag name and its text content. */
export interface BlockView {
  tag: string; // upper-case tag name, e.g. "H1" | "H2" | "P" | "UL"
  text: string; // the block's trimmed text content
}

/**
 * PURE core: compute the anchor from the block list, the index of the block the selection starts in, and
 * the selected text. The heading walk mirrors how the body markdown lays out `## …` sections, so the
 * anchor the client sends matches what FLOW re-locates against.
 *
 * @param blocks      the prose root's block children, in document order.
 * @param blockIndex  the index of the block the selection starts in (-1 if unknown).
 * @param selectedText the exact selected snippet.
 */
export function computeAnchor(
  blocks: readonly BlockView[],
  blockIndex: number,
  selectedText: string,
): ReviewAnchor {
  return {
    originalText: selectedText,
    headingAnchor: nearestHeading(blocks, blockIndex),
    startLine: blockIndex < 0 ? 1 : blockIndex + 1,
  };
}

// The nearest `## `-level heading (an <h2>) at or above the block — walk backwards from the block. Falls
// back to the doc's first h2, then its <h1> title, then "".
function nearestHeading(blocks: readonly BlockView[], blockIndex: number): string {
  if (blockIndex >= 0) {
    for (let i = blockIndex; i >= 0; i--) {
      if (blocks[i]?.tag === "H2") return blocks[i]!.text;
    }
  }
  const h2 = blocks.find((b) => b.tag === "H2");
  if (h2) return h2.text;
  const h1 = blocks.find((b) => b.tag === "H1");
  return h1 ? h1.text : "";
}

// ── DOM adapter ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Build the anchor for a live DOM selection: read the prose root's block children, locate the block the
 * selection starts in, and delegate to the pure core.
 */
export function buildAnchor(prose: HTMLElement | null, range: Range, text: string): ReviewAnchor {
  if (!prose) return computeAnchor([], -1, text);
  const children = Array.from(prose.children) as HTMLElement[];
  const blocks: BlockView[] = children.map((el) => ({
    tag: el.tagName,
    text: (el.textContent ?? "").trim(),
  }));
  const block = startBlock(prose, range);
  const blockIndex = block ? children.indexOf(block) : -1;
  return computeAnchor(blocks, blockIndex, text);
}

// The block-level child of the prose root the selection starts in (ProseMirror renders each body block as
// a top-level child, so the child index is a faithful stand-in for the markdown body line).
function startBlock(prose: HTMLElement, range: Range): HTMLElement | null {
  let node: Node | null = range.startContainer;
  while (node && node.parentNode !== prose) node = node.parentNode;
  return node instanceof HTMLElement ? node : null;
}
