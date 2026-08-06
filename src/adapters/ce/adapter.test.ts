import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { CeAdapter } from './adapter.ts';

/** What each route answers. Tests reassign entries to simulate a failure. */
type Route = { status: number; body: unknown; link?: string };
let routes: Record<string, Route>;

let server: Server;
let baseUrl = '';

before(async () => {
  server = createServer((req, res) => {
    const route = routes[req.url ?? ''];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reason: 'Not Found' }));
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (route.link) headers.link = route.link;
    res.writeHead(route.status, headers);
    res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

const JOBS_PAGE_1 = '/api/v1/repos/acme%2Fwidget/-/jobs';
const JOBS_PAGE_2 = '/api/v1/repos/acme%2Fwidget/-/jobs?cursor=OPAQUE';

function healthy(): Record<string, Route> {
  return {
    '/api/v1/orgs': { status: 200, body: [{ id: 'o1', name: 'acme', enabled: true, suspended: false }] },
    '/api/v1/orgs/acme/-/repos': {
      status: 200,
      body: [
        {
          name: 'widget',
          fullName: 'acme/widget',
          enabled: true,
          status: 'activated',
          queueName: 'main',
          installedAt: '2026-07-29T18:02:07.000Z',
        },
      ],
    },
    [JOBS_PAGE_1]: {
      status: 200,
      link: `<${JOBS_PAGE_2}>; rel="next"`,
      body: [
        { jobId: 'j1', reason: 'schedule-all', status: 'success', addedAt: '2026-08-06T17:00:00.000Z' },
        { jobId: 'j2', reason: 'schedule-all', status: 'success' },
      ],
    },
    [JOBS_PAGE_2]: {
      status: 200,
      body: [{ jobId: 'j3', reason: 'schedule-all', status: 'error', error: { name: 'Err', message: 'boom' } }],
    },
  };
}

function adapter() {
  return new CeAdapter({ id: 'test', kind: 'ce', url: baseUrl, token: 'secret' });
}

test('collect walks every page of a two-page job list', async () => {
  routes = healthy();
  const result = await adapter().collect();

  assert.equal(result.repos.length, 1);
  assert.equal(result.runs.length, 3, 'the second page was not followed');
  assert.deepEqual(
    result.runs.map((r) => r.externalJobId),
    ['j1', 'j2', 'j3'],
  );
  assert.deepEqual(result.warnings, []);
});

test('a failed run keeps its error, a successful one carries none', async () => {
  routes = healthy();
  const { runs } = await adapter().collect();
  const [first, , failed] = runs;
  assert.equal(first?.status, 'success');
  assert.equal(first?.error, null);
  assert.deepEqual(first?.artifactErrors, []);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error, 'Err: boom');
});

test('a repo whose job family is off degrades to a warning, not an exception', async () => {
  routes = healthy();
  routes[JOBS_PAGE_1] = { status: 404, body: { reason: 'Not Found' } };

  const result = await adapter().collect();
  assert.equal(result.repos.length, 1, 'repositories should survive losing the job family');
  assert.equal(result.runs.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /Could not read runs for acme\/widget/);
});

test('losing the org list returns empty with a warning naming the setting', async () => {
  routes = healthy();
  routes['/api/v1/orgs'] = { status: 404, body: { reason: 'Not Found' } };

  const result = await adapter().collect();
  assert.deepEqual(result.repos, []);
  assert.deepEqual(result.runs, []);
  assert.match(result.warnings[0] ?? '', /MEND_RNV_API_ENABLED/);
});

test('preflight names the token when the server rejects it', async () => {
  routes = healthy();
  routes['/api/v1/orgs'] = { status: 401, body: { reason: 'Unauthorized' } };
  routes['/system/v1/status'] = { status: 401, body: { reason: 'Unauthorized' } };

  const result = await adapter().preflight();
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /WITHE_CE_TOKEN/.test(p.detail)));
});

test('preflight reports reachable-but-empty rather than a blank dashboard', async () => {
  routes = healthy();
  routes['/system/v1/status'] = { status: 200, body: {} };
  routes['/api/v1/orgs/acme/-/repos'] = { status: 200, body: [] };

  const result = await adapter().preflight();
  assert.equal(result.ok, true);
  assert.equal(result.reachableButEmpty, true);
});

test('the constructor refuses a source with no credential', () => {
  assert.throws(() => new CeAdapter({ id: 'test', kind: 'ce', url: baseUrl }), /needs a token/);
  assert.throws(() => new CeAdapter({ id: 'test', kind: 'ce', token: 'x' }), /needs a url/);
});
