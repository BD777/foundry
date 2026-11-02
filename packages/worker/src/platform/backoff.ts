/**
 * A capped exponential wait: baseMs after the first failure (attempt 0),
 * doubling with each one after it, never more than maxMs.
 */
export function exponentialBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}
