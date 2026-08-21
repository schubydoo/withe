/**
 * Which of the four "Renovate server" messages a source's row shows (Task 4.3).
 *
 * Extracted from the page so the branch order is an assertion rather than a
 * re-reading — the same pattern as staleness.ts, next-run.ts and repos/group.ts.
 * The order matters: `no-server` is decided first, because a source with no
 * server never reports facts whether or not it has synced, and the
 * "no sync yet" message would otherwise promise facts that will never come.
 */
import type { SourceSystem } from '../../db/queries.ts';

export type SystemPanel = 'facts' | 'never-synced' | 'no-server' | 'api-off';

/** Whether the source reported anything at all from its system API. */
export function hasSystemFacts(system: SourceSystem): boolean {
  return (
    system.queueDepth !== null ||
    system.runnerVersion !== null ||
    system.bootedAt !== null ||
    system.oldestQueuedAt !== null
  );
}

export function systemPanel(system: SourceSystem, everSynced: boolean): SystemPanel {
  // A log directory (or any kind with no server) has nothing to report in any
  // sync state, so this precedes the never-synced check.
  if (!system.reportsSystemFacts) return 'no-server';
  // Reachable only for a server-backed source, so the message stays true there.
  if (!everSynced) return 'never-synced';
  return hasSystemFacts(system) ? 'facts' : 'api-off';
}
