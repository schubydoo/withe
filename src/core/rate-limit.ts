/**
 * The forge rate-limit warning threshold and the arithmetic around it (F-10).
 *
 * Pure and in its own module, like `staleness.ts`, so the health page and the
 * tests read the same rule and neither computes the threshold inline.
 */

/** Below this fraction of the limit, the health page warns. */
export const RATE_LIMIT_LOW = 0.2;

/**
 * The fraction of the forge rate limit still available, from 0 to 1. Null when
 * the limit is unknown or zero, which reads as "cannot say" rather than "none
 * left" — the same distinction the client draws for a missing header.
 */
export function headroomFraction(remaining: number, limit: number): number | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return remaining / limit;
}

/**
 * Whether headroom is below the warning threshold. Unknown headroom is not low:
 * a missing or zero limit must not raise a false alarm.
 */
export function isLow(remaining: number, limit: number): boolean {
  const fraction = headroomFraction(remaining, limit);
  return fraction !== null && fraction < RATE_LIMIT_LOW;
}

/** The headroom as a whole-number percent, or null when it cannot be computed. */
export function headroomPercent(remaining: number, limit: number): number | null {
  const fraction = headroomFraction(remaining, limit);
  return fraction === null ? null : Math.round(fraction * 100);
}
