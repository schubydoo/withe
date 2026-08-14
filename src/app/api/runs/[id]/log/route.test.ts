/**
 * The log route's own credential check, tested without the proxy layer.
 *
 * Calling the handler directly is the point: it is the one route that returns
 * real repository content, and the proxy layer it normally sits behind is not
 * an authorization boundary. If this check ever stops running, no test that
 * goes through the server would notice.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openDatabase } from '../../../../../db/client.ts';
import { renovateRun, repo, source } from '../../../../../db/schema.ts';
import { GET } from './route.ts';

const AUTH = { user: 'operator', pass: 'correct horse battery staple' };
const original = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), 'withe-log-route-'));

after(() => {
  process.env = original;
  rmSync(dir, { recursive: true, force: true });
});

/** One run, addressable as id 1, on a source that will not answer. */
function databaseWithOneRun(): string {
  const path = join(dir, 'runs.db');
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

function call(headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request('https://withe.example/api/runs/1/log', { headers }), {
    params: Promise.resolve({ id: '1' }),
  });
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

test('with auth configured, the handler refuses an anonymous caller itself', async () => {
  process.env.WITHE_AUTH_USER = AUTH.user;
  process.env.WITHE_AUTH_PASS = AUTH.pass;

  const anonymous = await call();
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Basic/);

  const wrong = await call({ authorization: basic(AUTH.user, 'guess') });
  assert.equal(wrong.status, 401);
});

test('the right credential gets past the check and on to the run itself', async () => {
  process.env.WITHE_AUTH_USER = AUTH.user;
  process.env.WITHE_AUTH_PASS = AUTH.pass;
  process.env.WITHE_DB_PATH = '/nonexistent/withe.db';

  // 503 is the answer for a database that has not synced yet. Any status other
  // than 401 proves the credential was accepted; this one proves the handler
  // carried on into its own work.
  const response = await call({ authorization: basic(AUTH.user, AUTH.pass) });
  assert.equal(response.status, 503);
});

test('with auth off, the handler serves as it always did', async () => {
  delete process.env.WITHE_AUTH_USER;
  delete process.env.WITHE_AUTH_PASS;
  process.env.WITHE_DB_PATH = '/nonexistent/withe.db';

  const response = await call();
  assert.equal(response.status, 503);
});

test('an unreachable source produces no upstream URL and no credential', async () => {
  delete process.env.WITHE_AUTH_USER;
  delete process.env.WITHE_AUTH_PASS;
  process.env.WITHE_DB_PATH = databaseWithOneRun();
  // Credentials in the URL and a token in the header: both are in the message
  // the client throws, and neither may reach the browser. SEC-9.
  process.env.WITHE_CE_URL = 'https://withe:sup3rsecret@127.0.0.1:1';
  process.env.WITHE_CE_TOKEN = 'mend-rnv-admin-secret-9f2c41ab';

  const response = await call();
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.equal(body.includes('sup3rsecret'), false, body);
  assert.equal(body.includes('mend-rnv-admin-secret-9f2c41ab'), false, body);
  assert.equal(body.includes('127.0.0.1'), false, body);
  assert.match(body, /Could not read that log/);
});
