// board-paths — the board's own files as a process file names them, read one way for the lane guard
// (`exec/guard/allow.mjs`, the lists) and the land's board-only commit check (`merge/picks.mjs`, a test).
import { posix } from "node:path";
import { escapesRoot } from "../process/spec/shape.mjs";
import { globMatch } from "./gate.mjs";

// The board's own files (field 75), as the process file `spec` names them and `read.mjs` resolves them,
// from the root: each kind's table, contract blocks and create blocks and `status.note` as `paths`, and
// each kind's `at.files` and `file.glob` (its `{id}` any name) as `globs`, so an item file made or removed
// passes too. A path or glob is kept when it stays inside the repository, the test the spec's own check
// uses (`escapesRoot(spec.root, p)`); an item id never builds one.
export function boardPaths(spec) {
  const paths = [];
  const globs = [];
  const base = typeof spec?.root === "string" ? spec.root : ".";
  if (!spec || escapesRoot(".", base)) return { paths, globs };
  const inRepo = (from) => (p) => typeof p === "string" && p !== "" && !escapesRoot(from, p);
  for (const kind of Object.values(spec.kinds ?? {})) {
    paths.push(kind?.at?.table, ...[kind?.contract?.blocks ?? []].flat());
    paths.push(...[kind?.create?.blocks ?? []].flat().map((b) => b?.file));
    globs.push(kind?.at?.files, kind?.file?.glob?.replaceAll?.("{id}", "*"));
  }
  const fromBase = (list) => [
    ...new Set(list.filter(inRepo(base)).map((p) => posix.normalize(posix.join(base, p)))),
  ];
  const note = spec.status?.note;
  return {
    paths: [...fromBase(paths), ...(inRepo(".")(note) ? [posix.normalize(note)] : [])],
    globs: fromBase(globs),
  };
}

// The same files as a path test: (path) => boolean, for a repo-relative, `/`-separated path.
export function boardPathTest(spec) {
  const { paths, globs } = boardPaths(spec);
  const exact = new Set(paths);
  return (path) => exact.has(path) || (globs.length > 0 && globMatch(globs, path));
}
