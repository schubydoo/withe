/**
 * The pagination client's refusals, tested without a server.
 *
 * `resolveSameOrigin` is what keeps the admin-scoped bearer token on the
 * configured server: CE issues no read-only credential, so a pagination link
 * that led elsewhere would hand the whole installation over (SECURITY.md).
 * These tests pin every way a Link header could point the client astray.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCeClient, paginate, parseNextLink, resolveSameOrigin } from './client.ts';

const BASE = 'https://ce.internal:8443';
const CONFIG = { baseUrl: BASE, token: 'token-under-test' };

test('a client cannot be built without a token', () => {
  assert.throws(() => createCeClient({ baseUrl: BASE, token: '' }), /WITHE_CE_TOKEN/);
});

test('a relative pagination target resolves against the configured server', () => {
  const url = resolveSameOrigin(BASE, '/api/v1/orgs?cursor=OPAQUE');
  assert.equal(url.href, 'https://ce.internal:8443/api/v1/orgs?cursor=OPAQUE');
});

test('an absolute link to another origin is refused, not followed', () => {
  assert.throws(() => resolveSameOrigin(BASE, 'https://elsewhere.example/x'), /off the configured server/);
});

test('a protocol-relative link is absolute in disguise and is refused too', () => {
  assert.throws(() => resolveSameOrigin(BASE, '//elsewhere.example/x'), /off the configured server/);
});

test('a link carrying embedded credentials is refused outright', () => {
  assert.throws(
    () => resolveSameOrigin(BASE, 'https://user:secret@ce.internal:8443/api/v1/orgs'),
    /embedded credentials/,
  );
});

test('rel=next is found bare, quoted, or among other relation types', () => {
  assert.equal(parseNextLink('</page2>; rel=next'), '/page2');
  assert.equal(parseNextLink('nonsense, </page2>; rel=next'), '/page2');
  assert.equal(parseNextLink('</page2>; rel="prefetch next"'), '/page2');
});

test('a comma inside the target does not split the header field', () => {
  assert.equal(parseNextLink('</page?ids=a,b>; rel="next"'), '/page?ids=a,b');
});

test('no header, and a header with no next relation, both yield null', () => {
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink('</page1>; rel="prev", </page9>; rel="last"'), null);
});

async function collectPages<T>(pages: AsyncGenerator<T[], void, undefined>): Promise<T[][]> {
  const all: T[][] = [];
  for await (const page of pages) all.push(page);
  return all;
}

test('paginate refuses a redirect rather than following it', async (t) => {
  t.mock.method(globalThis, 'fetch', (async () =>
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })) as typeof fetch);

  await assert.rejects(collectPages(paginate(CONFIG, '/api/v1/orgs')), /does not follow redirects/);
});

test('paginate fails loudly on an error status instead of yielding junk', async (t) => {
  t.mock.method(globalThis, 'fetch', (async () =>
    new Response('{"reason":"boom"}', { status: 500 })) as typeof fetch);

  await assert.rejects(collectPages(paginate(CONFIG, '/api/v1/orgs')), /CE responded 500/);
});

test('paginate sends the token, follows next, and stops at the page cap', async (t) => {
  const requests: { url: string; auth: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    return new Response('[{"jobId":"j"}]', {
      status: 200,
      headers: { link: '</api/v1/orgs?cursor=MORE>; rel="next"' },
    });
  }) as typeof fetch);

  const pages = await collectPages(paginate<{ jobId: string }>(CONFIG, '/api/v1/orgs', 3));

  assert.equal(pages.length, 3, 'the runaway guard must stop an endless next chain');
  assert.deepEqual(pages[0], [{ jobId: 'j' }]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.auth === 'Bearer token-under-test'));
  assert.ok(requests.every((r) => r.url.startsWith('https://ce.internal:8443/')));
});
