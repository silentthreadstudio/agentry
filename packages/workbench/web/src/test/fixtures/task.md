## Goal

Build the ONE markdown↔Tiptap serializer module (`mdToTiptap` / `tiptapToMd`) plus the golden round-trip
corpus that asserts `tiptapToMd(mdToTiptap(x)) === normalize(x)` over real `.agentry/` artifacts.

## Contract

- **owns:** `packages/workbench/web/src/routes/work/live/doc/markdown-serializer.ts` and the golden corpus.
- **exposes:** `mdToTiptap(body)`, `tiptapToMd(doc)`, and the `normalize(body)` canonical form.
- **must NOT touch:** `CommentMark.ts`, `DocDrawer.tsx`, `server/**`.

## Approach

Inherit ADR-004 verbatim: frontmatter is split off before the editor; only `body` round-trips; one module owns
both directions; built on a known md library. A failing golden test **blocks the build**.

The canonical form is the round-trip itself:

```ts
export function normalize(body: string): string {
  return tiptapToMd(mdToTiptap(body));
}
```

## Acceptance

- `tiptapToMd(mdToTiptap(x)) === normalize(x)` passes for every corpus artifact.
- A deliberately-introduced lossy mapping *fails* a golden test.
- `normalize` is byte-stable on a no-op (same input → same output).
