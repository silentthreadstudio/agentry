// Bounded-concurrency map (the parallel seam for the live probe loops). The probe matrices are independent
// runs — each `prepareSandbox` is a fresh temp dir — so they CAN run in parallel; the only thing that must be
// bounded is HOW MANY at once, because each Agentry cell spawns subagents (too many ⇒ API rate limits + heavy
// machine load). This is the one shared primitive both probes drive their work items through.
//
// CONTRACT (the invariants the probes rely on):
//   - ORDER-PRESERVING: result[i] is `fn(items[i], i)`, regardless of which worker finished first.
//   - BOUNDED: at most `max(1, min(limit, items.length))` invocations of `fn` are in flight at once.
//   - WORKER-POOL: a shared cursor hands each worker the next index until the items are exhausted (no batching
//     — a fast item never waits on a slow sibling in its "batch", which is the whole point over chunked Promise.all).
//   - Promise.all SEMANTICS: a thrown/rejected `fn` rejects the whole pool. Callers that want per-item recovery
//     wrap their own work in try/catch (the probes already do).
//   - With `limit <= 1` the workers collapse to ONE: indices are pulled 0,1,2,… and each awaited before the next,
//     so `fn` fires strictly in index order — byte-identical to a plain serial `for` loop (the default-1 invariant).

/**
 * Map `items` through `fn` with at most `limit` concurrent invocations, preserving input order in the result.
 * Empty input ⇒ `[]` (no workers spawned). A rejected `fn` rejects the returned promise (Promise.all semantics).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  const workers = Math.max(1, Math.min(limit, items.length));
  let cursor = 0; // the shared cursor — each worker pulls the next index until the items are exhausted.

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
