/**
 * The log route's own credential check, tested without the proxy layer.
 *
 * Calling the handler directly is the point: it is the one route that returns
 * real repository content, and the proxy layer it normally sits behind is not
 * an authorization boundary. If this check ever stops running, no test that
 * goes through the server would notice.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { GET } from './route.ts';

const AUTH = { user: 'operator', pass: 'correct horse battery staple' };
const original = { ...process.env };

after(() => {
  process.env = original;
});

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
