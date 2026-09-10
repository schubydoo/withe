import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createGithubForge, ForgeError } from './github.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Record every request and answer each from a handler keyed on the path. */
function stub(reply: (url: string) => StubReply): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const { status = 200, body = {}, headers = {} } = reply(url);
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { calls };
}

const RATE_HEADERS = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4990',
  'x-ratelimit-reset': '1700000000',
};

test('an open pull request reads as open', async () => {
  stub(() => ({ body: { state: 'open', merged: false, head: { ref: 'renovate/x' }, user: { login: 'renovate[bot]' } } }));
  const forge = createGithubForge({ token: 't' });
  const snap = await forge.pullRequest('owner', 'repo', 7);
  assert.deepEqual(snap, {
    state: 'open',
    closeType: null,
    closedAt: null,
    headRef: 'renovate/x',
    authorLogin: 'renovate[bot]',
  });
});

test('a merged pull request reads as merged, with the merge time', async () => {
  stub(() => ({ body: { state: 'closed', merged: true, merged_at: '2026-09-01T10:00:00Z', head: { ref: 'renovate/x' }, user: { login: 'renovate[bot]' } } }));
  const forge = createGithubForge({ token: 't' });
  const snap = await forge.pullRequest('owner', 'repo', 7);
  assert.equal(snap?.state, 'merged');
  assert.equal(snap?.closeType, 'merge');
  assert.equal(snap?.closedAt?.toISOString(), '2026-09-01T10:00:00.000Z');
});

test('a closed but unmerged pull request reads as closed', async () => {
  stub(() => ({ body: { state: 'closed', merged: false, closed_at: '2026-09-02T10:00:00Z', head: { ref: 'renovate/x' }, user: { login: 'renovate[bot]' } } }));
  const forge = createGithubForge({ token: 't' });
  const snap = await forge.pullRequest('owner', 'repo', 7);
  assert.equal(snap?.state, 'closed');
  assert.equal(snap?.closeType, 'close');
  assert.equal(snap?.closedAt?.toISOString(), '2026-09-02T10:00:00.000Z');
});

test('a 404 is not an error, because a gone pull request is not a fault to fix', async () => {
  stub(() => ({ status: 404, body: { message: 'Not Found' } }));
  const forge = createGithubForge({ token: 't' });
  assert.equal(await forge.pullRequest('owner', 'repo', 7), null);
});

test('a server error throws a ForgeError carrying the status', async () => {
  stub(() => ({ status: 500, body: {} }));
  const forge = createGithubForge({ token: 't' });
  await assert.rejects(() => forge.pullRequest('owner', 'repo', 7), (error: unknown) => {
    assert.ok(error instanceof ForgeError);
    assert.equal(error.status, 500);
    return true;
  });
});

test('the request carries the bearer token and the API version', async () => {
  const { calls } = stub(() => ({ body: { state: 'open' } }));
  const forge = createGithubForge({ token: 'secret-token' });
  await forge.pullRequest('owner', 'repo', 7);
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer secret-token');
  assert.equal(headers.get('x-github-api-version'), '2022-11-28');
  assert.match(calls[0]?.url ?? '', /\/repos\/owner\/repo\/pulls\/7$/);
});

test('a Enterprise Server base is honored', async () => {
  const { calls } = stub(() => ({ body: { state: 'open' } }));
  const forge = createGithubForge({ token: 't', apiBaseUrl: 'https://ghe.example/api/v3/' });
  await forge.pullRequest('owner', 'repo', 7);
  assert.match(calls[0]?.url ?? '', /^https:\/\/ghe\.example\/api\/v3\/repos\//);
});

test('the combined commit status flattens to one word', async () => {
  const forge = createGithubForge({ token: 't' });
  stub(() => ({ body: { state: 'success', total_count: 3 } }));
  assert.equal(await forge.commitStatus('o', 'r', 'sha'), 'success');
  stub(() => ({ body: { state: 'failure', total_count: 1 } }));
  assert.equal(await forge.commitStatus('o', 'r', 'sha'), 'failure');
  stub(() => ({ body: { state: 'error', total_count: 1 } }));
  assert.equal(await forge.commitStatus('o', 'r', 'sha'), 'failure');
  stub(() => ({ body: { state: 'pending', total_count: 0 } }));
  assert.equal(await forge.commitStatus('o', 'r', 'sha'), 'none');
});

test('a commit with no status endpoint reads as none, not a failure', async () => {
  stub(() => ({ status: 404, body: {} }));
  const forge = createGithubForge({ token: 't' });
  assert.equal(await forge.commitStatus('o', 'r', 'sha'), 'none');
});

test('a server error on the status endpoint throws', async () => {
  stub(() => ({ status: 500, body: {} }));
  const forge = createGithubForge({ token: 't' });
  await assert.rejects(() => forge.commitStatus('o', 'r', 'sha'), ForgeError);
});

test('headroom is null before the first call and reads the rate-limit headers after', async () => {
  stub(() => ({ body: { state: 'open' }, headers: RATE_HEADERS }));
  const forge = createGithubForge({ token: 't' });
  assert.equal(forge.headroom(), null);
  await forge.pullRequest('owner', 'repo', 7);
  const room = forge.headroom();
  assert.equal(room?.limit, 5000);
  assert.equal(room?.remaining, 4990);
  assert.equal(room?.fraction, 4990 / 5000);
  assert.equal(room?.resetAt?.getTime(), 1700000000 * 1000);
});

test('an empty token is refused', () => {
  assert.throws(() => createGithubForge({ token: '' }), /WITHE_GITHUB_TOKEN/);
});
