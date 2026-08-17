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
      if (cancelled) return;
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

  if (snapshot === null) return null;

  const ageNow =
    snapshot.ageSecondsAtPoll === null
      ? null
      : snapshot.ageSecondsAtPoll + (Date.now() - snapshot.polledAt) / 1000;
  const text = bannerText(snapshot.status, ageNow, snapshot.intervalSeconds);
  if (text === null) return null;

  return (
    <p
      role="status"
      aria-live="polite"
      className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
    >
      {text}{' '}
      <a className="underline" href="/health">
        Health
      </a>
      .
    </p>
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
