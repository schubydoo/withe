'use client';

import { useEffect, useState } from 'react';

import { describeCountdown } from './next-run.ts';

/**
 * A live countdown to the next Renovate run (B-5).
 *
 * The instant is computed on the server from the runner's own schedule and
 * passed in; this only counts it down, reading "due now" within `graceMs` of the
 * estimate and nothing once it is more stale than that. A null instant renders
 * nothing — a source that reports no usable schedule says nothing rather than
 * guessing at one.
 */
export function NextRun({ atMs, graceMs }: { atMs: number | null; graceMs: number }) {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (atMs === null) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined) timer = setInterval(() => forceRender((n) => n + 1), 30_000);
    };
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    // Pause the tick on a hidden tab and catch up on return, like the staleness
    // banner next to it — there is nothing to count down while nobody is looking.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        forceRender((n) => n + 1);
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [atMs]);

  if (atMs === null) return null;
  const remainingSeconds = Math.round((atMs - Date.now()) / 1000);
  const text = describeCountdown(remainingSeconds, graceMs / 1000);
  if (text === null) return null;
  // The server renders with its clock and the browser hydrates with its own a
  // moment later; when the two land on opposite sides of a rounding boundary the
  // text differs ("in 34" vs "in 33 minutes"), which React reports as a hydration
  // mismatch. The difference is a second of wall-clock, not a bug, so keep the
  // server's text and let the first tick correct it.
  return <span suppressHydrationWarning>next Renovate run {text}</span>;
}
