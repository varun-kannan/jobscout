/**
 * Bounded parallelism for engines that need a second request per posting.
 *
 * Ashby and SmartRecruiters both return a list of briefs and keep the
 * description behind a per-posting call. Firing those unbounded would mean
 * hundreds of simultaneous requests to one host and a swift rate limit.
 */

/** Run `worker` over `items`, at most `limit` at a time, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
