// measure-session on synthetic transcripts and ledgers. No real transcript content lives here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { measure, parseArgs, render } from "./measure-session.mjs";

const SCRIPT = fileURLToPath(new URL("./measure-session.mjs", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "measure-session-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const stamp = (day) => `2026-10-${day}T10:00:00.000Z`;
const tool = (name, input, id = `tu${++seq}`) => ({ type: "tool_use", id, name, input });
const asst = (sessionId, day, ...blocks) =>
  JSON.stringify({
    parentUuid: null,
    type: "assistant",
    sessionId,
    timestamp: stamp(day),
    message: { role: "assistant", content: blocks },
  });
const user = (sessionId, day, content) =>
  JSON.stringify({
    parentUuid: null,
    type: "user",
    sessionId,
    timestamp: stamp(day),
    message: { role: "user", content },
  });
const agent = (type, prompt) => tool("Agent", { subagent_type: type, prompt });
const write = (dir, name, lines) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
};
const opts = (over) => ({ transcripts: [], ledgers: [], since: null, json: false, ...over });

describe("transcripts", () => {
  const dir = join(tmp, "t1");
  write(dir, "s1.jsonl", [
    '{"type":"api-request-blob","message":{"x":"{\\"type\\":\\"user\\"}"}}',
    "not json at all",
    user("s1", "25", "<command-name>/agentry:start</command-name>"),
    asst("s1", "25", agent("agentry:implementer", "agentry-task: R-1 role=build\nwork")),
    asst("s1", "25", agent("agentry:implementer", "just do the thing")),
    asst("s1", "25", agent("agentry:explorer", "agentry-task: R-9 role=build\nlook")),
    asst("s1", "25", agent("agentry:verifier", "agentry-task: R-1 role=verify\ncheck")),
    asst("s1", "25", agent("general-purpose", "agentry-task: R-1 role=verify round=2\ncheck")),
    asst("s1", "25", tool("mcp__plugin_agentry_mem__memory_recall", { query: "x" })),
    asst("s1", "25", tool("Bash", { command: 'agentry mem recall --query "x"' })),
    asst("s1", "25", tool("Bash", { command: "agentry mem recall-ish --help" })),
    asst("s1", "25", tool("Bash", { command: "git cherry-pick abc123" })),
    asst("s1", "25", tool("Bash", { command: "git cherry-pick --abort" })),
    asst("s1", "25", tool("Bash", { command: 'node "/p/scripts/lane.mjs" merge R-1 --preflight' })),
    asst("s1", "25", tool("Bash", { command: 'node "/p/scripts/lane.mjs" merge R-1 --message m' })),
  ]);
  write(join(dir, "s2", "subagents"), "agent-1.jsonl", [
    asst("s2", "26", tool("Skill", { skill: "agentry:start" })),
    asst("s2", "26", tool("Bash", { command: "node board.mjs status" }, "st1")),
    user("s2", "26", [
      {
        type: "tool_result",
        tool_use_id: "st1",
        content: [{ type: "text", text: '{"kind":"started-by-hand"}' }],
      },
    ]),
    asst("s2", "26", tool("Bash", { command: "cat notes" }, "other")),
    user("s2", "26", [{ type: "tool_result", tool_use_id: "other", content: "merged-by-hand" }]),
  ]);

  it("counts work dispatches, markers, merges, recall, nudges and start", async () => {
    const s = await measure(opts({ transcripts: [dir] }));
    assert.equal(s.sessions, 2);
    assert.equal(s.files, 2);
    assert.deepEqual(s.dispatches.byType, { implementer: 2, verifier: 1, "general-purpose": 1 });
    assert.equal(s.dispatches.work, 4);
    assert.equal(s.dispatches.marked, 3);
    assert.equal(s.dispatches.viaExecShare, 0.75);
    assert.equal(s.merges.handCherryPicks, 1);
    assert.equal(s.merges.laneTasks, 1);
    assert.equal(s.merges.laneShare, 0.5);
    assert.equal(s.recall.calls, 2, "the MCP tool and the CLI");
    assert.equal(s.recall.sessionsWithRecall, 1);
    assert.deepEqual(s.verifyDispatchesPerTask, { tasks: 1, mean: 2, max: 2 });
    assert.equal(s.nudges["started-by-hand"], 1);
    assert.equal(s.nudges["merged-by-hand"] ?? 0, 0);
    assert.deepEqual(s.start, { typed: 1, conductor: 1, neither: 0 });
  });

  it("keeps only events on or after --since", async () => {
    const s = await measure(opts({ transcripts: [dir], since: "2026-10-26" }));
    assert.equal(s.sessions, 1);
    assert.equal(s.dispatches.work, 0);
    assert.deepEqual(s.start, { typed: 0, conductor: 1, neither: 0 });
  });

  it("reads a single file path", async () => {
    const s = await measure(opts({ transcripts: [join(dir, "s1.jsonl")] }));
    assert.equal(s.files, 1);
    assert.equal(s.dispatches.work, 4);
  });

  it("is zero, not NaN, on an empty set", async () => {
    const empty = join(tmp, "empty");
    write(empty, "e.jsonl", []);
    const s = await measure(opts({ transcripts: [empty] }));
    assert.equal(s.dispatches.viaExecShare, null);
    assert.equal(s.recall.perSession, null);
    assert.ok(render(s).includes("n/a"));
  });

  it("never prints transcript text", async () => {
    const secret = join(tmp, "secret");
    write(secret, "x.jsonl", [
      asst(
        "s",
        "25",
        agent("agentry:implementer", "agentry-task: R-1 role=build\nPLAINTEXT-MARKER"),
      ),
    ]);
    const s = await measure(opts({ transcripts: [secret] }));
    assert.ok(!render(s).includes("PLAINTEXT-MARKER"));
    assert.ok(!JSON.stringify(s).includes("PLAINTEXT-MARKER"));
  });
});

describe("ledgers", () => {
  const dir = join(tmp, "t2");
  const ledgers = join(tmp, "root", ".agentry", "run", "process", "ledger");
  const brief = join(tmp, "brief.md");
  writeFileSync(brief, "Facts:\n- [gotcha · g:1] a\n- [fact · p:2] b\nOther\n- plain bullet\n");
  const round = (extra) => ({ n: 1, role: "verify", mode: "fresh", brief, at: "x", ...extra });
  const ledger = (id, origin, state, rounds) => ({ v: 1, id, origin, state, rounds });
  mkdirSync(ledgers, { recursive: true });
  const put = (l) => writeFileSync(join(ledgers, `${l.id}.json`), JSON.stringify(l));
  put(
    ledger("A-1", "exec", "closed", [
      round({ role: "build", guards: ["uncommitted files in the worktree: a"] }),
      round({ verdict: "FAIL" }),
      round({ verdict: "PASS", step: "recheck", mode: "resume" }),
      round({ verdict: "PASS WITH NOTES", final: true }),
    ]),
  );
  put(ledger("A-2", "adopted", "merged", [round({ verdict: "PASS" })]));
  put(
    ledger("A-3", "exec", "stopped", [
      round({ role: "build", guards: ["main touched: x"] }),
      round({ verdict: "FAIL" }),
      round({ verdict: "FAIL" }),
      round({ verdict: "FAIL" }),
      round({ verdict: "PASS", void: true }),
    ]),
  );
  write(dir, "s.jsonl", [
    asst("s", "25", agent("agentry:implementer", "agentry-task: A-1 role=build\n")),
    asst("s", "25", agent("agentry:implementer", "agentry-task: A-2 role=build\n")),
  ]);

  it("counts a marked dispatch as exec only when its ledger origin is exec", async () => {
    const s = await measure(opts({ transcripts: [dir], ledgers: [join(tmp, "root")] }));
    assert.equal(s.dispatches.marked, 2);
    assert.equal(s.dispatches.viaExec, 1);
    assert.equal(s.dispatches.viaExecShare, 0.5);
  });

  it("reports verdicts, fresh-final rate, guard trips and facts from the ledgers", async () => {
    const s = await measure(opts({ transcripts: [dir], ledgers: [ledgers] }));
    const l = s.ledgers;
    assert.equal(l.tasks, 3);
    assert.deepEqual(l.verifyRounds, { tasks: 3, mean: 2.33, max: 3 });
    assert.equal(l.tasksAtThreeVerdicts, 2);
    assert.deepEqual(l.freshFinal, { passed: 2, withFinal: 1, rate: 0.5 });
    assert.deepEqual(l.guardTrips, {
      mainTouched: 1,
      dirty: 1,
      noCommits: 0,
      tipMoved: 1,
      stopped: 1,
    });
    assert.equal(l.briefs.dispatches, 10);
    assert.equal(l.briefs.facts, 20);
    assert.equal(l.briefs.withFacts, 10);
  });
});

describe("cli", () => {
  it("parses repeated and multi-value flags", () => {
    const o = parseArgs([
      "--transcripts",
      "a",
      "b",
      "--ledger",
      "l",
      "--since",
      "2026-10-24",
      "--json",
    ]);
    assert.deepEqual(o.transcripts, ["a", "b"]);
    assert.deepEqual(o.ledgers, ["l"]);
    assert.equal(o.since, "2026-10-24T00:00:00.000Z");
    assert.equal(o.json, true);
  });

  it("rejects a missing path, a bad date and an unknown flag", () => {
    assert.match(parseArgs([]).error, /--transcripts/);
    assert.match(parseArgs(["--transcripts", "a", "--since", "nope"]).error, /--since/);
    assert.match(parseArgs(["--transcripts", "a", "--wat"]).error, /unknown flag/);
  });

  it("prints JSON with --json and exits 2 on bad usage", () => {
    const dir = join(tmp, "t1");
    const out = JSON.parse(
      execFileSync("node", [SCRIPT, "--transcripts", dir, "--json"], { encoding: "utf8" }),
    );
    assert.equal(out.dispatches.work, 4);
    assert.throws(
      () => execFileSync("node", [SCRIPT], { stdio: "pipe" }),
      (e) => e.status === 2,
    );
  });
});
