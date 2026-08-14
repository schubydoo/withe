/**
 * The healthcheck's own contract, tested where the container reads it.
 *
 * A 200 from this route is what tells Docker the container is well, so the
 * cases that must answer 503 are the point: no database, and a worker that
 * stopped syncing while the web process kept serving.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openDatabase } from '../../../db/client.ts';
import { source, syncStatus } from '../../../db/schema.ts';
import { GET } from './route.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-health-'));
const original = { ...process.env };

after(() => {
  process.env = original;
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

/** A database whose one source last succeeded `agoSeconds` ago, or never. */
function database(agoSeconds: number | null): string {
  counter += 1;
  const path = join(dir, `h${counter}.db`);
  const { sqlite, db } = openDatabase(path, { role: 'owner' });
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(source).values({ id: 'default', kind: 'ce' }).run();
  if (agoSeconds !== null) {
    const at = new Date(Date.now() - agoSeconds * 1000);
    db.insert(syncStatus)
      .values({ sourceAdapterId: 'default', startedAt: at, finishedAt: at, outcome: 'ok' })
      .run();
  }
  sqlite.close();
  return path;
}

function call(dbPath: string, intervalSeconds = 300): Promise<Response> {
  process.env.WITHE_CONFIG = join(dir, 'absent.yaml');
  process.env.WITHE_DB_PATH = dbPath;
  process.env.WITHE_SYNC_INTERVAL_SECONDS = String(intervalSeconds);
  return Promise.resolve(GET());
}

test('a recent sync answers 200 and says how old the data is', async () => {
  const response = await call(database(60));
  assert.equal(response.status, 200);

  const body = (await response.json()) as { status: string; lastSyncAgeSeconds: number };
  assert.equal(body.status, 'ok');
  assert.ok(body.lastSyncAgeSeconds >= 60 && body.lastSyncAgeSeconds < 120);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a worker that stopped syncing answers 503, which a plain HTTP check would not', async () => {
  const response = await call(database(3 * 300 + 60));
  assert.equal(response.status, 503);

  const body = (await response.json()) as { status: string; staleSources: string[] };
  assert.equal(body.status, 'stale');
  assert.deepEqual(body.staleSources, ['default']);
});

test('a database that has never synced is not called healthy', async () => {
  const response = await call(database(null));
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { status: string }).status, 'never-synced');
});

test('no database at all is answered rather than thrown', async () => {
  const response = await call(join(dir, 'nothing-here.db'));
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { status: string }).status, 'never-synced');
});

test('the answer carries no repository data', async () => {
  const response = await call(database(60));
  const text = await response.text();
  // It is the one route that answers without credentials, so it must not be a
  // way to read the inventory.
  assert.doesNotMatch(text, /repo|full_name|org|token/i);
});
