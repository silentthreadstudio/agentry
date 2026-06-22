// The shape-extractor — RE-EXPORT barrel (ADR-001 + T-10 relocation). The canonical implementation was relocated
// by T-10 into the NEUTRAL `src/conduct/extract.ts` so the live moat probe and `store/read.ts` can consume it
// WITHOUT importing this probe's folder (no cross-probe coupling). This module keeps the `rightsizing/extract.ts`
// import path the rightsizing probe + its tests use, re-exporting the relocated symbols verbatim — one
// implementation, two import paths, zero duplication.

export {
  DegenerateRunError,
  extractShape,
  extractKind,
  type ExtractContext,
} from "../conduct/extract.ts";
