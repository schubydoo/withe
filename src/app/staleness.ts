/**
 * What the staleness banner says, and when (B-9).
 *
 * The dashboard used to compute staleness once, at render, against two missed
 * intervals — while `core/health.ts` and the container healthcheck called it
 * stale after three. Two parts of one product told the reader two different
 * things. This module is the one place that decides, and it borrows the single
 * threshold from `core/health.ts` so the page and the healthcheck can never
 * disagree again.
 *
 * It is pure so it can be tested without a browser. The React shell in
 * `staleness-banner.tsx` only polls `/api/health`, ages the number on screen,
 * and renders what `bannerText` returns.
 */
import { STALE_AFTER_INTERVALS } from '../core/health.ts';
import { magnitude } from './format.ts';

/** Poll no faster than this, whatever the configured interval. */
export const MIN_POLL_SECONDS = 15;

/** Fall back to this when the server reports no interval (the database does not
 * exist yet, so it answered before any config-derived interval was known). */
const NO_INTERVAL_FALLBACK_SECONDS = 60;

/**
 * A data age as words that keep meaning as they grow: "less than a minute old",
 * "1 minute old", "12 minutes old", "3 hours old", "2 days old". "stale" is not
 * a duration; NFR-18 wants the state named in words, and a number the reader can
 * judge for themselves beats a label they have to trust.
 */
export function describeAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return 'less than a minute old';
  const { value, unit } = magnitude(s);
  return `${value} ${unit}${value === 1 ? '' : 's'} old`;
}

/**
 * Is the freshest source older than the shared threshold? A source that has
 * never synced is not stale — it is unstarted — and returns false here so the
 * caller can say the different thing.
 */
export function isStale(ageSeconds: number | null, syncIntervalSeconds: number): boolean {
  if (ageSeconds === null) return false;
  return ageSeconds > syncIntervalSeconds * STALE_AFTER_INTERVALS;
}

/** How often to re-poll `/api/health`, derived from the sync interval rather
 * than a fixed number: there is no news between syncs, so a fresh sync is the
 * soonest the answer can change. Floored so a misconfigured tiny interval does
 * not turn into a busy loop. */
export function pollIntervalMs(syncIntervalSeconds: number | undefined): number {
  const base =
    typeof syncIntervalSeconds === 'number' && syncIntervalSeconds > 0
      ? syncIntervalSeconds
      : NO_INTERVAL_FALLBACK_SECONDS;
  return Math.max(MIN_POLL_SECONDS, base) * 1000;
}

/**
 * The banner line to show, or null to show nothing. `ageSeconds` is the age
 * *now* — the caller keeps it aging between polls — so the banner can appear the
 * moment it crosses the threshold, not only when the next poll lands. Staleness
 * is re-derived from that age with the shared constant, so a server that still
 * says `ok` and a client whose age has just crossed agree the instant they can.
 */
export function bannerText(status: string, ageSeconds: number | null, syncIntervalSeconds: number): string | null {
  if (status === 'never-synced') {
    return 'Withe has never completed a sync. Everything shown is empty rather than out of date.';
  }
  if (status === 'unreadable') {
    return 'Withe cannot read its database, so what is shown may be out of date.';
  }
  // Two ways the data is stale, and the banner must catch both:
  //
  //  - The reported age is itself past the threshold. This is the single-source
  //    case, and the case where the server still said `ok` on its last poll but
  //    the age has crossed since — the client re-derives it so the banner
  //    appears the moment it can, not only when the next poll lands.
  //  - The server said `stale` while the reported age is recent. `assess`
  //    reports the *freshest* source's age but turns stale when *any* source is
  //    past the threshold, so on a multi-source install the age can read fresh
  //    while /api/health returns 503. Honoring only the age here would leave the
  //    banner silent while the healthcheck is red — the split-brain this module
  //    exists to remove, moved rather than closed. Name it without the freshest
  //    age, which would understate a source that is hours behind.
  if (isStale(ageSeconds, syncIntervalSeconds) && ageSeconds !== null) {
    return `Data is ${describeAge(ageSeconds)}. It may not reflect what Renovate has done since.`;
  }
  if (status === 'stale') {
    return 'Some sources are out of date. What is shown may not reflect what Renovate has done since.';
  }
  return null;
}
