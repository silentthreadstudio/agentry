// mem update — patch a fact in place, for curation. `--supersedes` retires the
// named fact, as on write. A scope that would move the fact between the project and global roots is
// refused (write it anew, with --supersedes); `--status active` is refused on a non-active fact (bring an
// archived one back with mem recover; a superseded fact stays superseded).
//
// run(argv) -> { exit, out }   exit 0 = updated, 1 = refused, 2 = usage
import { MEMORY_TYPES, SCOPES } from "../domain/schema.mjs";
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { badInput, invalidState } from "../tools/errors.mjs";
import { failed, ok, refused } from "../tools/result.mjs";

const fields = {
  id: { kind: "string", value: "<id>", required: true, doc: "the fact to patch" },
  text: { kind: "string", doc: "the new text" },
  tags: { kind: "list", value: "<tag>", doc: "a tag (replaces the fact's tags)" },
  tagsClear: { kind: "flag", doc: "remove all the fact's tags (writes tags: [])" },
  type: { kind: "enum", options: MEMORY_TYPES, doc: "the new type" },
  scope: { kind: "enum", options: SCOPES, doc: "the new scope, within the fact's own root" },
  confidence: { kind: "number", min: 0, max: 1, doc: "the new confidence, 0 to 1" },
  status: { kind: "enum", options: ["active", "superseded"], doc: "the new status" },
  supersedes: { kind: "string", value: "<id>", doc: "the id of a fact this one replaces" },
};

export const noSpec = true;
export const help = {
  usage: usage("update", fields),
  purpose: "Patch a fact in place: text, tags, type, scope, confidence, status or supersedes.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem update --id g:01J… --confidence 0.9",
};

const stuck = ({ status }) =>
  invalidState(
    "cannot set this memory active",
    `it is '${status}'`,
    status === "archived"
      ? "use `agentry mem recover` to restore an archived memory"
      : "supersession is final: write the fact anew with `agentry mem write`",
  );

export const run = (argv) =>
  command("update", fields, argv, (service, { id, tagsClear, ...given }) => {
    if (tagsClear && given.tags)
      return refused(badInput("tags", "either --tags or --tags-clear, not both"));
    const patch = tagsClear ? { ...given, tags: [] } : given;
    const outcome = service.update(id, patch);
    if (!outcome.ok) return failed(outcome, stuck);
    const { ok: _ok, ...payload } = outcome;
    return ok({ ...payload, updated: true });
  });
