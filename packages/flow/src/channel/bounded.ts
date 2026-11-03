// Bound a watcher lifecycle step (chokidar `ready` / `close`). Under heavy load chokidar can fall back
// to watching an ancestor (a stat error on the target makes it climb to the parent) and rescan a busy
// directory for minutes, so a step that normally takes milliseconds may never settle. Rather than hang
// startup/shutdown, resolve after `ms` and say so on stderr (stdout is the MCP transport).
export const WATCHER_STEP_MS = 5000;

export async function bounded(
  step: Promise<unknown>,
  what: string,
  ms = WATCHER_STEP_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
    timer.unref();
  });
  const stalled = await Promise.race([step.then(() => false), timedOut]);
  clearTimeout(timer);
  if (stalled) process.stderr.write(`[flow] ${what} did not settle within ${ms} ms; continuing\n`);
}
