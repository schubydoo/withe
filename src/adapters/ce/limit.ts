/**
 * Run tasks with a ceiling on how many are in flight.
 *
 * Section 4.3 caps concurrency to one source at 4. That is not politeness: the
 * Terms permit suspension or IP blocking for disproportionate load, so the cap
 * is a contractual limit (tad.md Section 7.6).
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
