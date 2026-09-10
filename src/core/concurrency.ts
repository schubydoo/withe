/**
 * Run tasks with a ceiling on how many are in flight.
 *
 * Generic and source-agnostic, so both the CE adapter and the forge enrichment
 * share one implementation. The ceiling itself is the caller's policy: the CE
 * adapter caps at 4 as a contractual limit on one Renovate server (Section 4.3,
 * tad.md Section 7.6), and the forge enrichment picks its own budget for GitHub.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error('Concurrency limit must be at least 1');

  const results = new Array<R>(items.length);
  let next = 0;
  let inFlight = 0;
  let peak = 0;

  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        results[index] = await worker(items[index] as T, index);
      } finally {
        inFlight -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
