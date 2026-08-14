import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addressOf,
  authGuard,
  createThrottle,
  credentialsMatch,
  isExempt,
  unauthorized,
} from './basic-auth.ts';

const EXPECTED = { user: 'operator', pass: 'correct horse battery staple' };

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://withe.example/repos', { headers });
}

test('the configured credential is accepted', () => {
  assert.equal(credentialsMatch(EXPECTED, basic(EXPECTED.user, EXPECTED.pass)), true);
  // The scheme is case-insensitive per RFC 7617, and clients vary.
  assert.equal(
    credentialsMatch(EXPECTED, basic(EXPECTED.user, EXPECTED.pass).replace('Basic', 'basic')),
    true,
  );
});

test('a password containing a colon survives the split', () => {
  const expected = { user: 'operator', pass: 'a:b:c' };
  assert.equal(credentialsMatch(expected, basic(expected.user, expected.pass)), true);
});

test('anything else is rejected, whatever its length', () => {
  assert.equal(credentialsMatch(EXPECTED, null), false);
  assert.equal(credentialsMatch(EXPECTED, ''), false);
  assert.equal(credentialsMatch(EXPECTED, basic('operator', 'wrong')), false);
  assert.equal(credentialsMatch(EXPECTED, basic('someone', EXPECTED.pass)), false);
  // A prefix of the real password must not read as closer than a wild guess.
  assert.equal(credentialsMatch(EXPECTED, basic('operator', 'correct hors')), false);
  assert.equal(credentialsMatch(EXPECTED, `Bearer ${EXPECTED.pass}`), false);
  assert.equal(credentialsMatch(EXPECTED, 'Basic not-base64-at-all'), false);
  assert.equal(credentialsMatch(EXPECTED, 'Basic'), false);
  // No colon means no username, which is not a credential.
  assert.equal(
    credentialsMatch(EXPECTED, `Basic ${Buffer.from('operator').toString('base64')}`),
    false,
  );
});

test('only the health route is exempt', () => {
  assert.equal(isExempt('/api/health'), true);
  assert.equal(isExempt('/'), false);
  assert.equal(isExempt('/repos'), false);
  assert.equal(isExempt('/api/runs/12/log'), false);
  // A path that merely starts the same way is a different route.
  assert.equal(isExempt('/api/health/detail'), false);
});

test('a refusal carries the challenge and no data', async () => {
  const response = unauthorized();
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') ?? '', /^Basic realm="Withe"/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /repo|run|token/i);
});

test('repeated failures from one address are delayed, and the delay is capped', () => {
  const throttle = createThrottle();
  const now = 1_000_000;

  // The first few are free: an operator mistyping a password should not wait.
  assert.equal(throttle.penalty('10.0.0.5', now), 0);
  assert.equal(throttle.penalty('10.0.0.5', now), 0);
  assert.equal(throttle.penalty('10.0.0.5', now), 0);

  assert.equal(throttle.penalty('10.0.0.5', now), 500);
  assert.equal(throttle.penalty('10.0.0.5', now), 1000);

  for (let i = 0; i < 50; i += 1) throttle.penalty('10.0.0.5', now);
  assert.equal(throttle.penalty('10.0.0.5', now), 5000);

  // One address's history does not slow another down.
  assert.equal(throttle.penalty('10.0.0.6', now), 0);
});

test('the count is forgotten after the window and after a success', () => {
  const throttle = createThrottle();
  const now = 1_000_000;

  for (let i = 0; i < 5; i += 1) throttle.penalty('10.0.0.5', now);
  assert.ok(throttle.penalty('10.0.0.5', now) > 0);

  assert.equal(throttle.penalty('10.0.0.5', now + 300_001), 0);

  for (let i = 0; i < 5; i += 1) throttle.penalty('10.0.0.7', now);
  throttle.forget('10.0.0.7');
  assert.equal(throttle.penalty('10.0.0.7', now), 0);
});

test('the client address comes from the first forwarded entry', () => {
  assert.equal(addressOf(request({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
  assert.equal(addressOf(request({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(addressOf(request()), 'unknown');
});

test('the guard lets everything through when no credentials are configured', async () => {
  assert.equal(await authGuard(request(), '/repos', null, createThrottle()), null);
});

test('the guard admits the right credential and refuses the rest', async () => {
  const throttle = createThrottle();
  const authorized = request({ authorization: basic(EXPECTED.user, EXPECTED.pass) });
  assert.equal(await authGuard(authorized, '/repos', EXPECTED, throttle), null);

  const refused = await authGuard(request(), '/repos', EXPECTED, throttle);
  assert.equal(refused?.status, 401);

  const wrong = await authGuard(
    request({ authorization: basic(EXPECTED.user, 'wrong') }),
    '/api/runs/12/log',
    EXPECTED,
    throttle,
  );
  assert.equal(wrong?.status, 401);
});

test('the guard exempts the health route even when auth is on', async () => {
  assert.equal(await authGuard(request(), '/api/health', EXPECTED, createThrottle()), null);
});
