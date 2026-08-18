'use client';

import { useEffect, useState } from 'react';

import { bannerText, pollIntervalMs } from './staleness.ts';

/**
 * The staleness signal, on every page (B-9).
 *
 * A page left open overnight kept saying what it said when it loaded — and only
 * the dashboard said anything at all. This polls `/api/health`, ages the number
 * on screen between polls, and shows the same warning on every page. The
 * decision of what to say lives in `staleness.ts`; this is only the plumbing.
 */

/** How often the on-screen age is recomputed between polls. A render cadence,
 * not a network poll: the age only grows with the clock, so this keeps the
 * words current and lets the banner appear the moment it crosses the threshold,
 * without waiting for the next poll. */
const DISPLAY_REFRESH_MS = 15_000;

interface Snapshot {
  status: string;
  /** The age the server reported... */
  ageSecondsAtPoll: number | null;
  intervalSeconds: number;
  /** ...and the clock reading when it did, so the age can be advanced since. */
  polledAt: number;
}

export function StalenessBanner() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // A bare counter whose only job is to force a re-render on the display tick.
  const [, forceRender] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let displayTimer: ReturnType<typeof setInterval> | undefined;
    let lastInterval: number | undefined;

    function reschedulePoll(interval: number | undefined) {
      // Also stop when the tab is hidden: a poll already in flight when the tab
      // was hidden reaches its `finally` after onVisibilityChange cleared the
      // timer, and would otherwise reschedule and keep polling for the life of a
      // hidden tab, with no further visibilitychange to stop it.
      if (cancelled || document.visibilityState === 'hidden') return;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, pollIntervalMs(interval));
    }

    async function poll() {
      let interval = lastInterval;
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const body: unknown = await res.json();
        if (cancelled) return;
        const snap = readSnapshot(body);
        interval = snap.intervalSeconds;
        lastInterval = interval;
        setSnapshot(snap);
      } catch {
        // A failed poll is not stale data. Keep the last snapshot untouched — an
        // unreachable Withe and an unsynced Withe are different states — and try
        // again on the same cadence.
      } finally {
        reschedulePoll(interval);
      }
    }

    function startDisplay() {
      if (displayTimer === undefined) {
        displayTimer = setInterval(() => forceRender((n) => n + 1), DISPLAY_REFRESH_MS);
      }
    }
    function stopDisplay() {
      if (displayTimer !== undefined) {
        clearInterval(displayTimer);
        displayTimer = undefined;
      }
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        // Catch up at once on return, then resume the quiet cadence.
        void poll();
        startDisplay();
      } else {
        if (pollTimer !== undefined) {
          clearTimeout(pollTimer);
          pollTimer = undefined;
        }
        stopDisplay();
      }
    }

    void poll();
    startDisplay();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      stopDisplay();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const ageNow =
    snapshot === null || snapshot.ageSecondsAtPoll === null
      ? null
      : snapshot.ageSecondsAtPoll + (Date.now() - snapshot.polledAt) / 1000;
  const text = snapshot === null ? null : bannerText(snapshot.status, ageNow, snapshot.intervalSeconds);

  // The live region is always in the DOM, even before the first poll and while
  // there is nothing to say. A `role="status"` region announces changes *inside*
  // it; if the region and its text appeared together, assistive technology would
  // stay silent. So the wrapper is permanent and only its content is conditional.
  return (
    <div role="status" aria-live="polite">
      {text !== null && (
        // Matches the exposure banner in the layout it sits under: a full-width
        // bar whose text sits in the same centered, padded column (B-8), with the
        // dark palette the rest of the app gained in B-3.
        <div className="border-b border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 text-amber-900 dark:text-amber-200">
          <p className="mx-auto max-w-4xl px-8 py-2 text-sm">
            {text}{' '}
            <a className="underline" href="/health">
              Renovate health
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}

function readSnapshot(body: unknown): Snapshot {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  return {
    status: typeof record.status === 'string' ? record.status : 'ok',
    ageSecondsAtPoll:
      typeof record.lastSyncAgeSeconds === 'number' ? record.lastSyncAgeSeconds : null,
    intervalSeconds: typeof record.syncIntervalSeconds === 'number' ? record.syncIntervalSeconds : 60,
    polledAt: Date.now(),
  };
}
