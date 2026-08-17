'use client';

import { useEffect, useState } from 'react';

import { describeCountdown } from './next-run.ts';

/**
 * A live countdown to the next Renovate run (B-5).
 *
 * The instant is computed on the server from the runner's own schedule and
 * passed in; this only counts it down and flips to "overdue" when it passes. A
 * null instant renders nothing — a source that reports no usable schedule says
 * nothing rather than guessing at one.
 */
export function NextRun({ atMs }: { atMs: number | null }) {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (atMs === null) return;
    const id = setInterval(() => forceRender((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [atMs]);

  if (atMs === null) return null;
  const remainingSeconds = Math.round((atMs - Date.now()) / 1000);
  return <>next Renovate run {describeCountdown(remainingSeconds)}</>;
}
