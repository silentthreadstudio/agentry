// exec/guard/allow — what the main guard lets through: the `guard.allow` globs, Agentry's config and
// memory files and the board's own files, each unless a running lane owns it, and a commit on main
// that touches none of this lane's files; and the config edits that trip it while lanes run.
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { workflowPathOf } from "../../../process/read.mjs";
import { parseSpec } from "../../../process/spec.mjs";
import { escapesRoot, own } from "../../../process/spec/shape.mjs";
import { globMatch } from "../../gate.mjs";
import { git } from "../../worktree.mjs";
import { ownedOf, short } from "../lane.mjs";

// The lanes whose owned files no commit on main may touch (A44): every one still running.
export const RUNNING = ["building", "fixing", "verifying", "held"];

// Why a commit on main trips this lane's guard, as `landedOnly` asks (null when it passes). It passes when
// every path it touches (against its first parent) is one `guard.allow` lets through (`allowsPath`) and no
// running lane owns (A44), or when it touches none of this lane's files (`mine`, from `laneFiles`; field
// 81), whoever made it. An overlap is named, `<sha> touches <paths>, this lane's files`, and `hit` is
// called; "" when the commit or the lane's files cannot be read.
export function allowedCommit(root, allow, all, mine, hit = () => {}) {
  let owners;
  const allowedAll = (paths) => {
    try {
      owners ??= all
        .filter((l) => RUNNING.includes(l.state))
        .map((l) => ownedOf(root, l).map((o) => (typeof o === "string" ? o : o.path)));
    } catch {
      return false;
    }
    return paths.every(
      (path) =>
        allowsPath(allow, path) && !owners.some((owned) => owned.some((e) => ownsPath(e, path))),
    );
  };
  return (sha) => {
    const res = git(root, ["diff", "--no-renames", "--name-only", "-z", `${sha}^1`, sha, "--"]);
    if (res.status !== 0) return "";
    const paths = res.stdout.split("\0").filter(Boolean);
    if (allowedAll(paths)) return null;
    if (!mine) return "";
    const hits = paths.filter((p) => mine.changed.has(p) || mine.owned.some((e) => ownsPath(e, p)));
    if (!hits.length) return null;
    hit(hits);
    const more = hits.length > OVERLAP_SHOWN ? ` (+${hits.length - OVERLAP_SHOWN} more)` : "";
    return `${short(sha)} touches ${hits.slice(0, OVERLAP_SHOWN).join(", ")}${more}, this lane's files`;
  };
}

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

// The process file and its workflow file as main's HEAD commits them (paths from the root), parsed as
// `loadSpec` parses them: `{ tracked: false }` when HEAD has no process file there, else `{ tracked: true,
// spec }`, the spec null when it has a problem.
export function committedSpec(root, processRel, workflowRel) {
  const at = (path) => {
    const res = git(root, ["show", `HEAD:${path}`]);
    return res.status === 0 ? res.stdout : undefined;
  };
  const board = at(processRel);
  if (board === undefined) return { tracked: false };
  const { spec, problems } = parseSpec({ board, workflow: at(workflowRel) });
  return { tracked: true, spec: spec && !problems.length ? spec : null };
}

// The board paths a lane's guard lets through, never widened by an edit made after it started (F1, F2a):
// the process file as main's HEAD commits it when it is tracked there, else the paths `start` saved in
// the ledger (`boardAtStart`) from the spec as it loaded then; an older ledger without them, none.
function boardOf(root, ledger, processRel, workflowRel) {
  const committed = processRel ? committedSpec(root, processRel, workflowRel) : { tracked: false };
  if (committed.tracked) return boardPaths(committed.spec);
  const saved = ledger?.boardAtStart;
  const strings = (list) => (Array.isArray(list) ? list.filter((p) => typeof p === "string") : []);
  return { paths: strings(saved?.paths), globs: strings(saved?.globs) };
}

// The process file and its workflow file in use, as `loadSpec` resolves them, from the root: `{ processRel,
// workflowRel }`, each null when it is not inside the repository (or has no folder).
export function configPaths({ root, processPath }) {
  const file = processPath ?? join(root, ".agentry", "process.json");
  let dir;
  try {
    dir = realpathSync(dirname(file));
  } catch {
    return { processRel: null, workflowRel: null }; // no process file's folder: no config file to let through
  }
  const inRepo = (p) => (p && !p.startsWith("..") && !isAbsolute(p) ? p : null);
  const [processRel, workflowRel] = [file, workflowPathOf(file)].map((f) =>
    inRepo(
      relative(root, join(dir, basename(f)))
        .split(sep)
        .join("/"),
    ),
  );
  return { processRel, workflowRel };
}

// Agentry's own files the guard lets through like `guard.allow` paths (field 78): the harness config, and
// the memory store, committed or uncommitted.
const CONFIG_FILE = ".agentry/config.json";
const OWN_GLOBS = [".agentry/memory/**"];

// What the guards let through as `guard.allow` paths for `ledger`'s guard: its globs, Agentry's config in
// use (field 58: the process file and its workflow file, and `.agentry/config.json`), the memory store and
// the board's own files (`boardOf`).
export function allowOf(ctx, ledger) {
  const { processRel, workflowRel } = configPaths(ctx);
  const config = [processRel, workflowRel, CONFIG_FILE].filter(Boolean);
  const board = boardOf(ctx.root, ledger, processRel, workflowRel);
  return { globs: own(ctx.spec, "guard")?.allow ?? [], config, board };
}
const allowsPath = (allow, path) =>
  allow.config.includes(path) ||
  allow.board.paths.includes(path) ||
  matchesAny(allow.board.globs, path) ||
  matchesAny(OWN_GLOBS, path) ||
  matchesAny(allow.globs, path);

// A glob test with the gate's own matcher, as merge does.
const matchesAny = (globs, path) => globMatch(globs, path);

// Does an entry of a contract's owned files (a path, a directory, a glob, a bare file name, a
// `path:lines`) cover `path`? Read wide, case ignored: a doubt keeps the guard on.
export function ownsPath(entry, path) {
  const e = entry
    .toLowerCase()
    .replace(/:[\d\s,–-]+$/, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  const p = path.toLowerCase();
  if (p === e || p.startsWith(`${e}/`) || matchesAny([e], p)) return true;
  return !e.includes("/") && posix.basename(p) === e;
}

// The main edits `guard.allow` lets through: an allowed path (`allowsPath`) no running lane owns.
// When a running lane's owned files cannot be read, nothing is let through.
export function allowedEdit(root, allow, all) {
  let owned;
  try {
    owned = all
      .filter((l) => l.state !== "merged" && l.state !== "closed")
      .flatMap((l) => ownedOf(root, l).map((o) => (typeof o === "string" ? o : o.path)));
  } catch {
    return () => false;
  }
  return (path) => allowsPath(allow, path) && !owned.some((entry) => ownsPath(entry, path));
}

// The keys an uncommitted edit of Agentry's config may not change while lanes run: they decide what the
// guard lets through and what the gate checks (R1d-21 N3).
const GUARDED_KEYS = ["guard", "gate"];
// A value as one string with its keys sorted, so a re-indented file compares equal.
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return { guard: text, gate: text }; // not JSON: every guarded key reads as changed
  }
};

// Each process or workflow file in use edited in main (uncommitted) so that its `guard` or `gate` key
// differs from HEAD's, as a reason: `.agentry/workflow.json changes guard while lanes run → commit it
// between lanes`. `.agentry/config.json` holds neither key.
export function configTrips(root, allow, dirty) {
  const out = [];
  for (const path of allow.config.filter((p) => p !== CONFIG_FILE && dirty.has(p))) {
    let now = null;
    try {
      now = parsed(readFileSync(join(root, path), "utf8"));
    } catch {} // deleted: every key it held is gone
    const shown = git(root, ["show", `HEAD:${path}`]);
    const was = shown.status === 0 ? parsed(shown.stdout) : null;
    const keys = GUARDED_KEYS.filter((k) => canonical(own(now, k)) !== canonical(own(was, k)));
    if (keys.length)
      out.push(`${path} changes ${keys.join(" and ")} while lanes run → commit it between lanes`);
  }
  return out;
}

// The paths an overlap line names; past them it gives a count.
export const OVERLAP_SHOWN = 5;
