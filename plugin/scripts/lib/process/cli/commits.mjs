// board commits --learn [--min <n>] — the `commits` rules the default branch's history keeps (field 91):
// its last 500 first-parent subjects read, the Conventional Commits types plus each other type used
// `--min` times or more (default 3) with its count, the subject length and whether scopes are always there.
// Prints the rules for init to propose through its draft; writes nothing. Needs no process file.
//
// run(argv, { root }) -> { exit, out }
import { usageError } from "../../cli/help.mjs";
import { HISTORY, historySubjects, learnRules } from "../../lane/subjects.mjs";
import { defaultBranch } from "../git.mjs";

export const noSpec = true;
export const help = {
  usage: "commits --learn [--min <n>] [--json]",
  purpose:
    "The commits rules (subjectPattern, subjectMax) the default branch's history keeps. Writes nothing.",
  args: {},
  flags: {
    "--learn": "read the last 500 first-parent commits of the default branch and print their rules",
    "--min <n>": "how many uses a type outside Conventional Commits needs to be added (default 3)",
    "--json": "print { types: [{ type, count, standard }], subjectPattern, subjectMax, scoped }",
  },
  exits: { 0: "printed", 2: "usage" },
  example: "board commits --learn --min 5",
};

// `--min`'s value: a whole number of 1 or more, 3 when absent.
function minOf(argv) {
  const at = argv.indexOf("--min");
  if (at < 0) return { min: 3 };
  if (argv.lastIndexOf("--min") !== at) return { error: "--min is given twice" };
  const value = argv[at + 1];
  return /^[1-9]\d*$/.test(value ?? "")
    ? { min: Number(value) }
    : { error: "--min needs a whole number of 1 or more" };
}

export function run(argv, { root }) {
  if (!argv.includes("--learn")) return usageError("board commits", "needs --learn");
  const { min, error } = minOf(argv);
  if (error) return usageError("board commits", error);
  const stray = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--min");
  if (stray !== undefined) return usageError("board commits", `unexpected "${stray}"`);
  const branch = defaultBranch(root);
  const subjects = historySubjects(root, branch);
  const rules = learnRules(subjects, { min });
  if (argv.includes("--json")) return { exit: 0, out: JSON.stringify(rules) };
  const from =
    subjects.length === 0
      ? `no history${branch ? ` on ${branch}` : " (no default branch)"}: the standard Conventional Commits set`
      : `learned from ${subjects.length} first-parent commit(s) of ${branch} (the last ${HISTORY} at most)`;
  const types = rules.types.map(
    ({ type, count, standard }) => `${type} ${count}${standard ? "" : " (not standard)"}`,
  );
  const out = [
    `commits rules, ${from}:`,
    `  subjectPattern  ${JSON.stringify(rules.subjectPattern)}`,
    `  subjectMax      ${rules.subjectMax}`,
    `  scoped          ${rules.scoped ? "yes: every typed subject has a scope" : "no: a scope is optional"}`,
    `  types           ${types.join(", ")}`,
    `A type outside the standard set used fewer than ${min} times is left out. Nothing written: propose these as "commits" in the workflow draft.`,
  ];
  return { exit: 0, out: out.join("\n") };
}
