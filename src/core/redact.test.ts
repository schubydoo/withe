import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installRedaction, redact, REDACTED, secretsFrom } from './redact.ts';

test('a bearer token is removed but the word Bearer is kept', () => {
  const line = 'GET /api/v1/repos failed: Authorization: Bearer abcd1234efgh5678ijkl';
  const out = redact(line);
  assert.equal(out.includes('abcd1234efgh5678ijkl'), false);
  assert.match(out, /Bearer «redacted»/);
});

test('a MEND_RNV_ secret is removed and its name is kept', () => {
  const out = redact('env: MEND_RNV_ADMIN_API_SECRET=s3cret-value-here MEND_RNV_PLATFORM=github');
  assert.equal(out.includes('s3cret-value-here'), false);
  assert.match(out, /MEND_RNV_ADMIN_API_SECRET=«redacted»/);
  // A variable that is not a secret keeps its value, or the log stops being
  // useful for the thing it is read for.
  assert.match(out, /MEND_RNV_PLATFORM=github/);
});

test('forge tokens are removed by their documented prefixes', () => {
  for (const token of [
    'ghp_16CharactersAndMoreHere1234',
    'gho_16CharactersAndMoreHere1234',
    'github_pat_11ABCDEFG0abcdefghijklmno',
    'glpat-abcdefghijklmnopqrst',
  ]) {
    const out = redact(`cloning with ${token} now`);
    assert.equal(out.includes(token), false, `${token} survived`);
    assert.match(out, /«redacted»/);
  }
});

test('a credential inside a URL is removed and the host is kept', () => {
  const out = redact('connect ECONNREFUSED https://withe:sup3rsecret@renovate.home.lan/api/v1');
  assert.equal(out.includes('sup3rsecret'), false);
  assert.match(out, /https:\/\/withe:«redacted»@renovate\.home\.lan/);
});

test('the digests Renovate logs by the thousand are left alone', () => {
  // Redacting these would turn the log viewer into a wall of «redacted», which
  // is how a filter gets switched off.
  const line =
    'currentDigest 9db594c7a0e82298c121c18b7f08aa1579ce7341 ' +
    'sha256:5c1d9f6a1b2e3d4c5b6a7988990011223344556677889900aabbccddeeff0011';
  assert.equal(redact(line), line);
});

test('the configured secret is removed whatever shape it has', () => {
  const secrets = ['not-a-token-shape-at-all-1234'];
  const out = redact('preflight failed for not-a-token-shape-at-all-1234', secrets);
  assert.equal(out.includes('not-a-token-shape-at-all-1234'), false);
  assert.match(out, /preflight failed for «redacted»/);
});

test('a secret too short to be one is ignored rather than redacting the message', () => {
  assert.equal(redact('a run for the repo', ['run']), 'a run for the repo');
});

test('the secrets come from the sources and the password', () => {
  assert.deepEqual(
    secretsFrom({
      sources: [{ token: 'ce-token-value' }, {}],
      auth: { pass: 'the-password' },
    }),
    ['ce-token-value', 'the-password'],
  );
  assert.deepEqual(secretsFrom({ sources: [], auth: null }), []);
});

test('every console level is filtered, including a thrown Error', () => {
  const written: string[] = [];
  const fake = {
    log: (...a: unknown[]) => written.push(a.join(' ')),
    warn: (...a: unknown[]) => written.push(a.join(' ')),
    error: (...a: unknown[]) => written.push(a.join(' ')),
    debug: (...a: unknown[]) => written.push(a.join(' ')),
    info: (...a: unknown[]) => written.push(a.join(' ')),
  };

  installRedaction(['ce-token-value'], fake);

  fake.log('token is ce-token-value');
  fake.warn('token is ce-token-value');
  fake.error(new Error('upstream said Bearer abcd1234efgh5678ijkl'));
  fake.debug('token is ce-token-value');
  fake.info({ token: 'ce-token-value' });

  assert.equal(written.length, 5);
  for (const line of written) {
    assert.equal(line.includes('ce-token-value'), false, line);
    assert.equal(line.includes('abcd1234efgh5678ijkl'), false, line);
  }
  assert.ok(written.every((line) => line.includes(REDACTED)));
});
