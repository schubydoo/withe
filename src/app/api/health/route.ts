/**
 * Liveness with an opinion (Task 3.6, F-16's one exempt route).
 *
 * It answers without credentials, because a container healthcheck should not
 * need the operator's password, and it returns no repository data — only
 * whether Withe is telling the truth about how current it is.
 *
 * 200 means the database opened and a source synced recently. 503 means it
 * did not, which is the state a plain HTTP check reports as healthy.
 */
import { existsSync, statSync } from 'node:fs';

import { loadConfig } from '../../../config/load.ts';
import { assess, statusCodeFor } from '../../../core/health.ts';
import { openDatabase } from '../../../db/client.ts';
import { sourceHealth } from '../../../db/queries.ts';

export const dynamic = 'force-dynamic';

function answer(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function GET(): Response {
  const config = loadConfig();

  if (!existsSync(config.dbPath)) {
    return answer({ status: 'never-synced', detail: 'the database has not been created yet' }, 503);
  }

  // Opening it is the check. A file that exists and cannot be read is the
  // failure a healthcheck is for.
  let sources;
  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    sources = sourceHealth(db, new Date(0));
  } catch (cause) {
    // This is the one credential-less route, so the caller is unauthenticated:
    // the database error's internals must not go in the response body
    // (js/stack-trace-exposure). Log it for the operator instead — the redaction
    // filter installed over `console` sanitizes any credential in the message.
    console.error('health: reading source health failed', cause);
    return answer({ status: 'unreadable', detail: 'the database could not be read' }, 503);
  } finally {
    sqlite.close();
  }

  const health = assess(sources, config.syncIntervalSeconds);
  return answer(
    {
      status: health.status,
      lastSyncAgeSeconds: health.ageSeconds,
      staleSources: health.stale,
      syncIntervalSeconds: config.syncIntervalSeconds,
      databaseBytes: statSync(config.dbPath).size,
    },
    statusCodeFor(health.status),
  );
}
