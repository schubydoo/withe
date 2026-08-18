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
  // The inventory family is gated by both variables — the specification tags
  // getOrgs `Reporting`, which tad.md 4.4 had wrong.
  assert.match(result.warnings[0] ?? '', /MEND_RNV_API_ENABLED and MEND_RNV_API_ENABLE_REPORTING/);
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

test('TEMPORARY(org-discovery): configured names skip the request entirely', async () => {
  routes = healthy();
  // If anything asks, the answer is a failure. The point of the workaround is
  // that the call is not made, so asserting on the result would prove nothing.
  routes['/api/v1/orgs'] = { status: 500, body: { reason: 'must not be called' } };

  const configured = new CeAdapter({
    id: 'test',
    kind: 'ce',
    url: baseUrl,
    token: 'secret',
    orgs: ['acme'],
  });

  const result = await configured.collect();
  assert.equal(result.repos.length, 1);
  assert.equal(result.runs.length, 3);
  assert.deepEqual(result.warnings, []);
});

test('TEMPORARY(org-discovery): unset behaves exactly as before', async () => {
  routes = healthy();
  const discovered = await adapter().collect();
  const configured = await new CeAdapter({
    id: 'test',
    kind: 'ce',
    url: baseUrl,
    token: 'secret',
    orgs: ['acme'],
  }).collect();

  assert.deepEqual(
    configured.repos.map((r) => r.fullName),
    discovered.repos.map((r) => r.fullName),
  );
});

test('TEMPORARY(org-discovery): preflight says which mode it is in', async () => {
  routes = healthy();
  routes['/api/v1/orgs'] = { status: 500, body: { reason: 'must not be called' } };

  const result = await new CeAdapter({
    id: 'test',
    kind: 'ce',
    url: baseUrl,
    token: 'secret',
    orgs: ['acme'],
  }).preflight();

  assert.equal(result.ok, true, 'a named organization must not be a fatal problem');
  const note = result.problems.find((p) => p.setting?.includes('orgs'));
  assert.ok(note, 'preflight must say the names were configured, not discovered');
  assert.match(note.detail, /named by configuration/);
});

test('TEMPORARY(org-discovery): a misspelled name is visible, not silent', async () => {
  routes = healthy();
  // A live server answers 200 with an empty list for an organization it has
  // never heard of, so this is the shape a typo actually takes. Asserting on a
  // 404 would have tested a case that never happens.
  routes['/api/v1/orgs/typo/-/repos'] = { status: 200, body: [] };

  const result = await new CeAdapter({
    id: 'test',
    kind: 'ce',
    url: baseUrl,
    token: 'secret',
    orgs: ['typo'],
  }).collect();

  assert.deepEqual(result.repos, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /Configured organization 'typo'/);
  assert.match(result.warnings[0] ?? '', /Check the spelling/);
});

test('an empty organization is not a warning when names were discovered', async () => {
  routes = healthy();
  routes['/api/v1/orgs/acme/-/repos'] = { status: 200, body: [] };

  const result = await adapter().collect();
  assert.deepEqual(result.repos, []);
  assert.deepEqual(result.warnings, [], 'discovery cannot misspell a name it was given');
});

test('a disabled system API is reported but does not block the dashboard', async () => {
  routes = healthy();
  // healthy() defines no /system/v1/status, so the probe 404s.
  const result = await adapter().preflight();

  assert.equal(result.ok, true, 'Withe reads no system endpoint outside preflight');
  const note = result.problems.find((p) => p.probe === 'system');
  assert.ok(note);
  assert.equal(note.fatal, false);
  assert.match(note.setting ?? '', /MEND_RNV_API_ENABLE_SYSTEM/);
});

test('a metrics probe that cannot connect is reported, not thrown', async (t) => {
  routes = healthy();
  // Only the /metrics fetch dies; every specified endpoint keeps answering.
  // This is the one probe that reaches the network outside the generated
  // client, so its network failure is a status of 0, not an exception.
  const real = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/metrics')) return Promise.reject(new TypeError('fetch failed'));
    return real(input, init);
  }) as typeof fetch);

  const result = await adapter().preflight();

  const note = result.problems.find((p) => p.probe === 'metrics');
  assert.ok(note, 'the failed probe must be named');
  assert.equal(note.fatal, false, 'metrics are optional; their absence must not fail preflight');
  assert.match(note.detail, /answered 0/);
});

test('a repository list with no body counts as zero repositories, not a crash', async () => {
  routes = healthy();
  // 200 with a JSON `null` body: the generated client hands back data: null,
  // which is the arm the `?? []` guard exists for.
  routes['/api/v1/orgs/acme/-/repos'] = { status: 200, body: null };

  const result = await adapter().preflight();

  assert.equal(result.ok, true);
  assert.equal(result.reachableButEmpty, true, 'an empty answer is the empty-fleet case, not an error');
});

test('a repository list failure becomes a warning, not a crash', async () => {
  routes = healthy();
  routes['/api/v1/orgs/acme/-/repos'] = { status: 500, body: { reason: 'boom' } };
  const result = await adapter().collect();

  assert.deepEqual(result.repos, []);
  assert.deepEqual(result.runs, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /acme/);
});

test('the status endpoint, when it answers, names the forge', async () => {
  routes = healthy();
  routes['/system/v1/status'] = {
    status: 200,
    body: { platform: 'github', endpoint: 'https://api.github.com/' },
  };
  const result = await adapter().collect();

  assert.deepEqual(result.meta, {
    platform: 'github',
    webBaseUrl: 'https://github.com',
    scheduleCron: null,
    scheduleLastAt: null,
  });
});

test('the status endpoint carries the schedule when the server reports one', async () => {
  routes = healthy();
  routes['/system/v1/status'] = {
    status: 200,
    body: {
      platform: 'github',
      endpoint: 'https://api.github.com/',
      scheduler: { allJobs: { cron: '0 * * * *', lastScheduling: '2026-08-17T10:00:00.000Z' } },
    },
  };
  const result = await adapter().collect();

  assert.equal(result.meta?.scheduleCron, '0 * * * *');
  assert.deepEqual(result.meta?.scheduleLastAt, new Date('2026-08-17T10:00:00.000Z'));
});

test("the newest finished run's log names the pending updates", async () => {
  routes = healthy();
  routes[JOBS_PAGE_1] = {
    status: 200,
    body: [{ jobId: 'j1', reason: 'schedule-all', status: 'success', completedAt: '2026-08-06T17:05:00.000Z' }],
  };
  routes['/api/v1/repos/acme%2Fwidget/-/jobs/j1'] = {
    status: 200,
    body:
      '{"renovateVersion":"43.1.0","branchesInformation":[{"branchName":"renovate/lodash-5.x","prNo":7,' +
      '"upgrades":[{"depName":"lodash","updateType":"major","currentValue":"4.17.21","newValue":"5.0.0",' +
      '"packageFile":"package.json","datasource":"npm"}]}]}\n',
  };
  const result = await adapter().collect();

  assert.deepEqual(result.warnings, []);
  assert.equal(result.updates.length, 1);
  const update = result.updates[0];
  assert.equal(update?.dependencyName, 'lodash');
  assert.equal(update?.updateType, 'major');
  assert.equal(update?.state, 'pr-open');
  // The jobs endpoint does not report the runner version; the log does.
  assert.equal(result.runs[0]?.runnerVersion, '43.1.0');
});

test('a log that cannot be fetched costs a warning, never the run itself', async () => {
  routes = healthy();
  routes[JOBS_PAGE_1] = {
    status: 200,
    body: [{ jobId: 'j1', reason: 'schedule-all', status: 'success', completedAt: '2026-08-06T17:05:00.000Z' }],
  };
  // No log route: the job log endpoint answers 404.
  const result = await adapter().collect();

  assert.equal(result.runs.length, 1);
  assert.deepEqual(result.updates, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /Could not read updates for acme\/widget/);
  assert.match(result.warnings[0] ?? '', /404/);
});
