/**
 * NFR-8: the token is not in the database. Proved by reading the file.
 *
 * Every other test here asserts on rows through the query layer, which can
 * only see columns it knows to select. A credential that reached a column
 * nobody thought to check, or a page of a dropped table still present in the
 * file, would pass all of them. This reads the bytes instead.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { SourceAdapter } from '../adapters/types.ts';
import { openDatabase } from '../db/client.ts';
import { SyncLoop } from './sync.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-leak-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = 'mend-rnv-admin-secret-9f2c41ab';

/** The failure shape that puts an upstream string into `sync_status.error`. */
function failing(id: string, message: string): SourceAdapter {
  return {
    id,
    kind: 'ce',
    collect: () => Promise.reject(new Error(message)),
    fetchLog: () => Promise.reject(new Error('not used')),
    preflight: () => Promise.resolve([]),
  } as unknown as SourceAdapter;
}

async function syncedFile(name: string, message: string, secrets: string[]): Promise<Buffer> {
  const path = join(dir, `${name}.db`);
  const { sqlite, db } = openDatabase(path, { role: 'owner' });
  migrate(db, { migrationsFolder: './drizzle' });

  const loop = new SyncLoop(db, [failing('default', message)], {
    intervalMs: 60_000,
    stalledAfterMs: 60_000,
    log: () => {},
    secrets,
  });
  await loop.runCycle();

  // Closing checkpoints the WAL into the file. It is read too when it is still
  // there, because a write that only reached the journal is still a write.
  sqlite.close();
  // As bytes, not text: the file is not UTF-8, and decoding it would move the
  // very characters this test searches for.
  const wal = `${path}-wal`;
  return Buffer.concat([readFileSync(path), existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]);
}

test('an upstream failure that quotes the token stores no token', async () => {
  const contents = await syncedFile(
    'redacted',
    `GET https://renovate.home.lan/api/v1/repos failed: 401, sent Authorization: Bearer ${TOKEN}`,
    [TOKEN],
  );

  assert.equal(contents.includes(TOKEN), false, 'the token reached the database file');
  // The rest of the message survives, or the operator loses the reason it
  // failed along with the secret.
  assert.ok(contents.includes('renovate.home.lan'));
  assert.ok(contents.includes('«redacted»'));
});

test('the search can find a value that is really there', async () => {
  // Absence of evidence is not evidence of absence. This plants a string the
  // filter has no reason to remove and proves the scan would have caught it.
  const contents = await syncedFile('planted', 'the-cause-was-a-teapot', []);
  assert.ok(contents.includes('the-cause-was-a-teapot'), 'the file scan cannot see stored text');
});

/** An adapter that collects one run and, separately, can serve a log body. */
function collectingWithLog(id: string, logBody: string): SourceAdapter {
  return {
    id,
    kind: 'ce',
    collect: () =>
      Promise.resolve({
        repos: [
          {
            id: `${id}:acme/widget`,
            org: 'acme',
            name: 'widget',
            fullName: 'acme/widget',
            enabled: true,
            installStatus: 'activated',
            queueName: 'main',
            installedAt: null,
            removedAt: null,
            sourceAdapterId: id,
          },
        ],
        runs: [
          {
            id: `${id}:job-1`,
            repoId: `${id}:acme/widget`,
            externalJobId: 'job-1',
            triggerReason: 'schedule-all',
            queuedAt: new Date(),
            startedAt: new Date(),
            completedAt: new Date(),
            status: 'success',
            error: null,
            artifactErrors: [],
            // A reference to where the log lives, never the log itself.
            logLocation: 'jobs/job-1',
            runnerVersion: '43.0.0',
            sourceAdapterId: id,
          },
        ],
        updates: [],
        warnings: [],
      }),
    // The log body is served on demand by the route, never during a sync.
    fetchLog: () => Promise.resolve(new Response(logBody).body as ReadableStream<Uint8Array>),
    preflight: () => Promise.resolve([]),
  } as unknown as SourceAdapter;
}

test('a run is stored without its log body ever reaching the database', async () => {
  const marker = 'LOG-BODY-a1b2c3-must-never-be-persisted';
  const path = join(dir, 'no-log-content.db');
  const { sqlite, db } = openDatabase(path, { role: 'owner' });
  migrate(db, { migrationsFolder: './drizzle' });

  const loop = new SyncLoop(db, [collectingWithLog('default', marker)], {
    intervalMs: 60_000,
    stalledAfterMs: 60_000,
    log: () => {},
  });
  await loop.runCycle();
  sqlite.close();

  const wal = `${path}-wal`;
  const bytes = Buffer.concat([readFileSync(path), existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]);

  // The reference is stored; the body is not. NFR-12, and the same file scan
  // the planted test above proves can see stored text.
  assert.ok(bytes.includes('jobs/job-1'), 'the log location should be stored');
  assert.equal(bytes.includes(marker), false, 'the log body reached the database');
});
