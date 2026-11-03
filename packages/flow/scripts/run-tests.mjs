// Run the flow suite under a hard wall-clock cap. `--test-timeout` bounds tests and hooks but NOT a
// test file whose process never exits (a leaked fs watcher), which once stalled the repo gate for
// minutes. The suite normally takes ~6 s; past the cap, kill it and fail with a message.
import { spawn } from "node:child_process";

const CAP_MS = Number(process.env.FLOW_TEST_CAP_MS ?? 180_000);
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "--test-timeout=60000", "test/*.test.ts"],
  { stdio: "inherit", detached: true },
);

const timer = setTimeout(() => {
  process.stderr.write(
    `flow tests exceeded ${CAP_MS} ms: a test file is stalled (leaked watcher?); killing the suite\n`,
  );
  process.kill(-child.pid, "SIGKILL");
}, CAP_MS);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  process.exit(signal === null ? (code ?? 1) : 1);
});
