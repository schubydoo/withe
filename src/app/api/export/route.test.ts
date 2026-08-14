/**
 * The escape hatch, tested where it matters: with the worker dead (nothing
 * running but this handler), behind auth, and producing a copy you can reopen.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openDatabase } from '../../../db/client.ts';
import { renovateRun, repo, source } from '../../../db/schema.ts';
import { GET } from './route.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-export-test-'));
const original = { ...process.env };
after(() => {
  process.env = original;
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function populated(): string {
  counter += 1;
  const path = join(dir, `db${counter}.db`);
  const { sqlite, db } = openDatabase(path, { role: 'owner' });
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(source).values({ id: 'default', kind: 'ce' }).run();
  db.insert(repo)
    .values({ id: 1, sourceAdapterId: 'default', org: 'acme', name: 'widget', fullName: 'acme/widget', enabled: true })
    .run();
  db.insert(renovateRun)
    .values({ id: 1, sourceAdapterId: 'default', repoId: 1, externalJobId: 'job-1', status: 'success' })
    .run();
  sqlite.close();
  return path;
}

function call(url = 'https://withe.example/api/export'): Promise<Response> {
  return GET(new Request(url));
}

test('the JSON export carries every table, with the worker not running', async () => {
  process.env.WITHE_CONFIG = join(dir, 'absent.yaml');
  process.env.WITHE_DB_PATH = populated();
  delete process.env.WITHE_AUTH_USER;
  delete process.env.WITHE_AUTH_PASS;

  const response = await call();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /withe-export\.json/);

  const body = (await response.json()) as { tables: Record<string, unknown[]> };
  // Every table the schema creates, discovered dynamically.
  for (const table of ['source', 'repo', 'renovate_run', 'update', 'sync_status']) {
    assert.ok(table in body.tables, `missing table ${table}`);
  }
  assert.equal(body.tables.repo?.length, 1);
  assert.equal((body.tables.renovate_run?.[0] as { external_job_id: string }).external_job_id, 'job-1');
});

test('the sqlite export is a database you can reopen', async () => {
  process.env.WITHE_CONFIG = join(dir, 'absent.yaml');
  process.env.WITHE_DB_PATH = populated();

  const response = await call('https://withe.example/api/export?format=sqlite');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.sqlite3');

  const copyPath = join(dir, 'roundtrip.db');
  writeFileSync(copyPath, Buffer.from(await response.arrayBuffer()));
  const copy = new Database(copyPath, { readonly: true });
  try {
    const n = (copy.prepare('select count(*) as n from repo').get() as { n: number }).n;
    assert.equal(n, 1, 'the copied database did not carry the rows');
  } finally {
    copy.close();
  }
});

test('with auth on, the export refuses an anonymous caller', async () => {
  process.env.WITHE_CONFIG = join(dir, 'absent.yaml');
  process.env.WITHE_DB_PATH = populated();
  process.env.WITHE_AUTH_USER = 'operator';
  process.env.WITHE_AUTH_PASS = 'a-real-password';

  const response = await call();
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') ?? '', /^Basic/);
});

test('with no database yet, it says so rather than throwing', async () => {
  process.env.WITHE_CONFIG = join(dir, 'absent.yaml');
  process.env.WITHE_DB_PATH = join(dir, 'never-created.db');
  delete process.env.WITHE_AUTH_USER;
  delete process.env.WITHE_AUTH_PASS;

  const response = await call();
  assert.equal(response.status, 503);
});
