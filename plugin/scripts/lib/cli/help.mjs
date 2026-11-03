// help — the one help and error format of `board.mjs` and `lane.mjs` (A39). Every subcommand exports
// `help`: `{ usage, purpose, args, flags, exits, example }`; `--help` prints it the same way for all.
// A flag key with a second word (`--why <id>`, `--verify [static|live]`) takes a value: the router
// reads which options a subcommand takes from here, so the help and the parser cannot drift apart.
// An error is one line, `✗ <what>: <why> → <next command>`; exit 0 = ok, 1 = findings / stopped /
// needs the owner, 2 = refused / usage / bad config, the same in every subcommand.
//
// flagsOf(help) -> { "--why": true, "--json": false }        true = takes a value
// renderHelp(cli, sub, help) -> string                        one subcommand
// renderIndex(cli, subs: [{ name, help }]) -> string          `<cli> --help`
// say(what, why, next?) -> string                             the error line
// refuse(what, why, next?) -> { exit: 2, out }                that line as a refusal
// usageError(what, why) -> { exit: 2, out }                   a refusal pointing at `<what> --help`

const PAD = 2;

/** The options a subcommand takes, from its help: name → whether it takes a value. */
export function flagsOf(help) {
  return Object.fromEntries(
    Object.keys(help?.flags ?? {}).map((key) => {
      const [name, value] = key.split(" ");
      return [name, Boolean(value)];
    }),
  );
}

// `rows` as two columns, the first padded to the widest.
function table(rows) {
  if (!rows.length) return ["  none"];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width + PAD)}${v}`.trimEnd());
}

/** One subcommand's help: usage, purpose, args, flags, exit codes, one example. */
export function renderHelp(cli, sub, given) {
  const help = given ?? { usage: sub, purpose: "" };
  const usage = [help.usage].flat().map((u) => `${cli} ${u}`);
  return [
    `usage: ${usage.join(`\n${" ".repeat("usage: ".length)}`)}`,
    help.purpose,
    "",
    "args:",
    ...table(Object.entries(help.args ?? {})),
    "flags:",
    ...table(Object.entries(help.flags ?? {})),
    "exits:",
    ...table(Object.entries(help.exits ?? {})),
    "example:",
    `  ${help.example ?? ""}`,
  ].join("\n");
}

/** `<cli> --help`: every subcommand with its purpose, and the options every one of them takes. */
export function renderIndex(cli, subs) {
  return [
    `usage: ${cli} <subcommand> [--root <git root>] [--process <file>] [--help]`,
    "",
    "subcommands:",
    ...table(subs.map(({ name, help }) => [name, help?.purpose ?? ""])),
    "",
    `${cli} <subcommand> --help prints its args, flags, exit codes and an example.`,
    "--root and --process work with every subcommand: the git root, and the process file",
    "(default <root>/.agentry/process.json).",
  ].join("\n");
}

export const say = (what, why, next) => `✗ ${what}: ${why}${next ? ` → ${next}` : ""}`;
export const refuse = (what, why, next) => ({ exit: 2, out: say(what, why, next) });
export const usageError = (what, why) => refuse(what, why, `${what} --help`);
