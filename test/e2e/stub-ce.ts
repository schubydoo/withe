/**
 * A stand-in Renovate CE server for the end-to-end suite (Task 3.12).
 *
 * It serves the committed fixtures under `test/fixtures/ce/` for every endpoint
 * the CE adapter and the preflight probe reach, so the whole suite runs with no
 * live CE and no network. A `mode` switch provokes the one failure the UI is
 * built to explain: an operator whose Renovate API is switched off.
 *
 *   node test/e2e/stub-ce.ts --port 7700 --mode healthy
 *   node test/e2e/stub-ce.ts --port 7700 --mode degraded
 *
 * Endpoints (all GET; Withe never writes):
 *   /system/v1/status                          system-status probe
 *   /metrics                                    Prometheus probe (off here)
 *   /api/v1/orgs                                the org list
 *   /api/v1/orgs/{org}/-/repos                  the repositories
 *   /api/v1/repos/{orgRepo}/-/jobs             run history, paginated by Link
 *   /api/v1/repos/{orgRepo}/-/jobs/{jobId}     the NDJSON log
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ce');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

type Mode = 'healthy' | 'degraded';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const PORT = Number(arg('--port', '7700'));
const MODE = arg('--mode', 'healthy') as Mode;

function json(res: ServerResponse, status: number, body: string, link?: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (link) headers.link = link;
  res.writeHead(status, headers);
  res.end(body);
}

function notFound(res: ServerResponse, reason: string): void {
  json(res, 404, JSON.stringify({ reason }));
}

/**
 * Route one request. Kept as a pure function of (method, path, query, mode) so
 * the same logic is testable without a socket.
 */
export function route(method: string, url: string, mode: Mode, res: ServerResponse): void {
  const { pathname, searchParams } = new URL(url, 'http://stub');

  if (method !== 'GET') {
    // Withe never writes; anything else is a test bug, not a real request.
    json(res, 405, JSON.stringify({ reason: 'Withe issued a non-GET request' }));
    return;
  }

  // Degraded: the API is off, which is how a fresh CE ships (MEND_RNV_API_ENABLED
  // unset). Every reporting, system and metrics path 404s, so the preflight page
  // names the exact variables that are missing.
  if (mode === 'degraded' && (
    pathname.startsWith('/api/v1/') || pathname.startsWith('/system/v1/') || pathname === '/metrics'
  )) {
    notFound(res, 'API not enabled');
    return;
  }

  if (pathname === '/system/v1/status') return json(res, 200, '{}');
  if (pathname === '/metrics') return notFound(res, 'metrics not enabled');
  if (pathname === '/api/v1/orgs') return json(res, 200, fixture('orgs.json'));

  // /api/v1/orgs/{org}/-/repos
  if (/^\/api\/v1\/orgs\/[^/]+\/-\/repos$/.test(pathname)) {
    return json(res, 200, fixture('repos.json'));
  }

  // /api/v1/repos/{orgRepo}/-/jobs  (orgRepo is URL-encoded, so it has no slash)
  const jobsMatch = /^\/api\/v1\/repos\/([^/]+)\/-\/jobs$/.exec(pathname);
  if (jobsMatch) {
    const orgRepo = decodeURIComponent(jobsMatch[1] as string);
    const page = searchParams.get('cursor') === 'OPAQUE' ? 'jobs-page2.json' : 'jobs-page1.json';
    const body = jobsForRepo(orgRepo, page);
    // First page points at the second, so the adapter's pagination is exercised.
    const link = page === 'jobs-page1.json' ? `<${pathname}?cursor=OPAQUE>; rel="next"` : undefined;
    return json(res, 200, body, link);
  }

  // /api/v1/repos/{orgRepo}/-/jobs/{jobId}  — the log body (NDJSON)
  if (/^\/api\/v1\/repos\/[^/]+\/-\/jobs\/[^/]+$/.test(pathname)) {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(fixture('job.ndjson'));
    return;
  }

  notFound(res, `no stub route for ${pathname}`);
}

/** The repository whose newest run fails, so the failure-triage flow has content. */
const FAILING_REPO = 'acme/lever';

interface Job {
  jobId: string;
  status: string;
  error?: { name: string; message: string };
  [k: string]: unknown;
}

/**
 * Replay the committed job fixtures for one repository.
 *
 * The fixtures are a single repository's recorded history, so every repo would
 * otherwise return identical jobIds and the store's (source, jobId) unique key
 * would collapse them into one. Prefixing the jobId with the repo keeps each
 * repo's history its own, and one repo's newest run is turned into a failure so
 * the landing page has something to triage.
 */
function jobsForRepo(orgRepo: string, page: string): string {
  const tag = orgRepo.replace(/[^a-z0-9]/gi, '-');
  const jobs = (JSON.parse(fixture(page)) as Job[]).map((job) => ({
    ...job,
    jobId: `${tag}-${job.jobId}`,
  }));
  if (page === 'jobs-page1.json' && orgRepo === FAILING_REPO && jobs[0]) {
    jobs[0] = {
      ...jobs[0],
      status: 'error',
      error: { name: 'Error', message: 'a dependency failed to resolve against the registry' },
    };
  }
  return JSON.stringify(jobs);
}

function checkAuth(req: IncomingMessage): boolean {
  // The adapter always sends a bearer token; a missing one is a wiring bug in
  // the test, so reject it rather than let a broken run look healthy.
  return (req.headers.authorization ?? '').startsWith('Bearer ');
}

const server = createServer((req, res) => {
  if (!checkAuth(req)) {
    json(res, 401, JSON.stringify({ reason: 'missing bearer token' }));
    return;
  }
  route(req.method ?? 'GET', req.url ?? '/', MODE, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub-ce: listening on http://127.0.0.1:${PORT} (mode ${MODE})`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
