// command — the one way a verb runs, so the 12 of them stay thin: parse the options (a bad one is a usage
// error, exit 2), open the store (the roots the MCP server resolved: AGENTRY_GLOBAL_DIR, CLAUDE_PROJECT_DIR /
// AGENTRY_PROJECT_DIR; with no project dir in the env, the main checkout of the cwd's git repo) and load it, run the verb's handler, and
// print what it returned. A handler returns `ok(data)` or `refused(error)` (tools/result.mjs): data is
// printed (exit 0), a refusal's reason is printed (exit 1). An unexpected throw is the generic `internal`
// refusal: nothing about the host leaks into it.
//
// command(verb, fields, argv, handler) -> { exit, out }     handler(service, args) -> ok(...) | refused(...)
// EXITS                                                     the exit codes every verb's help lists
import { refuse } from "../../cli/help.mjs";
import { openMemory } from "../open.mjs";
import { resolveRoots } from "../resolution/roots.mjs";
import { parse } from "./args.mjs";
import { internal } from "./errors.mjs";
import { refusal, text } from "./render.mjs";

export const EXITS = { 0: "done", 1: "refused (the reason is printed)", 2: "usage" };

/** The memory service over the store the environment (or the cwd's repo) names, loaded. */
const open = (env = process.env, cwd = process.cwd()) => openMemory(resolveRoots(env, cwd));

export function command(verb, fields, argv, handler) {
  const parsed = parse(fields, argv);
  if (parsed.error) return refuse(`mem ${verb}`, parsed.error, `agentry mem ${verb} --help`);
  let result;
  try {
    result = handler(open(), parsed.args);
  } catch {
    result = { error: internal() };
  }
  if (result.error)
    return {
      exit: 1,
      out: parsed.json ? JSON.stringify({ error: result.error }) : refusal(verb, result.error),
    };
  return { exit: 0, out: parsed.json ? JSON.stringify(result.data) : text(result.data) };
}
