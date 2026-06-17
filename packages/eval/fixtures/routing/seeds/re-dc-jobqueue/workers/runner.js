// Worker process: the long-running side that pulls jobs and runs them. Today it is a bare loop
// skeleton — it ticks but claims nothing, runs no handler, and has no failure path. The worker that
// processes jobs (claim a pending job, run its handler, mark done or failed) and the dead-letter
// handler (route a repeatedly-failing job aside) are the missing pieces that hang off this loop.

let running = false;

export function start({ intervalMs = 1000 } = {}) {
  running = true;
  const tick = () => {
    if (!running) return;
    // No claim / run / retry logic yet.
    setTimeout(tick, intervalMs);
  };
  tick();
}

export function stop() {
  running = false;
}
