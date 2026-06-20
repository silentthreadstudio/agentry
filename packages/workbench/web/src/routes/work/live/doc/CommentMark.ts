// CommentMark — the UI-only ProseMirror comment mark (task 18, ported from prototype-document.html's
// `Comment` mark). A span gets this mark when the reviewer comments on it; the mark's position then
// tracks every later edit natively through ProseMirror's mapping, so an agent's edit doesn't orphan the
// anchor. It carries only the comment `id` (the link back to the sidecar entry).
//
// ── The serializer contract (ADR-004 / task 14) ──────────────────────────────────────────────────────
// The mark is named exactly `comment` because task 14's `markdown-serializer.ts` strips any mark named
// "comment" on the way to markdown — so a commented body round-trips to disk unchanged (the comment lives
// in `.review/<gate>.annotations.json`, never in the prose). Renaming this mark would silently break that
// round-trip; the name is load-bearing, not cosmetic.
import { Mark, mergeAttributes } from "@tiptap/react";
import type { RawCommands } from "@tiptap/react";

export interface CommentMarkAttributes {
  id: string | null;
}

/**
 * The `comment` mark. UI-only: it renders as `<span class="cmt-mark">` (highlighted in the editor) and
 * serializes to NOTHING (task 14 strips it). Its position tracks edits via ProseMirror mapping — the
 * native behaviour of any mark — which is the re-attach guarantee task 18 needs.
 */
export const CommentMark = Mark.create({
  name: "comment",

  addAttributes() {
    return {
      id: {
        default: null,
        // Round-trip the id through a data attribute so a copy/paste of the span keeps its link.
        parseHTML: (el) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs: CommentMarkAttributes) =>
          attrs.id ? { "data-comment-id": attrs.id } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span.cmt-mark" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "cmt-mark" }), 0];
  },

  addCommands() {
    // `setComment(id)` applies the mark to the current selection. Typed via Tiptap's RawCommands so the
    // command-map augmentation isn't needed (the `@tiptap/core` module isn't directly resolvable from
    // this package — only `@tiptap/react`'s re-exports are). The command is defined for completeness;
    // applying it requires the editor instance (held privately by DocDrawer — see SelectionBubble).
    const name = this.name;
    return {
      setComment:
        (id: string) =>
        ({ commands }: { commands: { setMark: (n: string, a: object) => boolean } }) =>
          commands.setMark(name, { id }),
    } as Partial<RawCommands>;
  },
});
