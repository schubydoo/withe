/**
 * End-to-end suite: the real app, a stub CE, one real browser (Task 3.12).
 *
 * No live CE and no network. It starts the stub CE, runs one real sync so the
 * database holds real rows, starts the standalone web server, and drives the
 * four flows a first-time operator walks with `agent-browser` (headless
 * Chromium). Each flow is named for the user-visible behaviour it protects, and
 * every page is audited against WCAG 2.1 AA (NFR-18).
 *
 * Cross-browser coverage (chromium, firefox, webkit — NFR-17) is a separate,
 * thinner Playwright smoke; agent-browser drives Chromium only.
 *
 *   npm run build && npm run e2e
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

const STUB_PORT = 7731;
const WEB_PORT = 31_371;
const SESSION = 'withe-e2e';
const work = mkdtempSync(join(tmpdir(), 'withe-e2e-'));
const dbPath = join(work, 'e2e.db');
const WEB = `http://127.0.0.1:${WEB_PORT}`;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function ab(args: string[]): string {
  try {
    return execFileSync('agent-browser', args, {
      encoding: 'utf8',
      env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    const e = cause as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/** The rendered text of a page, after the client has settled. */
function readPage(path: string): string {
  ab(['open', `${WEB}${path}`]);
  ab(['wait', '--load', 'networkidle']);
  return ab(['read']);
}

interface A11yResult {
  violations: { id: string; impact: string; nodes: { html: string }[] }[];
}

/** WCAG 2.1 A + AA violations on the page currently open. */
function audit(): A11yResult['violations'] {
  const raw = ab(['a11y', '--tags', 'wcag2a,wcag2aa,wcag21a,wcag21aa', '--json']);
  try {
    const parsed = JSON.parse(raw) as { data?: A11yResult };
    return parsed.data?.violations ?? [];
  } catch {
    return [{ id: 'audit-unreadable', impact: 'serious', nodes: [{ html: raw.slice(0, 200) }] }];
  }
}

function reportViolations(page: string, violations: A11yResult['violations']): void {
  for (const v of violations) {
    console.log(`     a11y ${page}: ${v.id} (${v.impact}), ${v.nodes.length} node(s)`);
    for (const n of v.nodes.slice(0, 3)) console.log(`       ${n.html.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

function startStub(mode: 'healthy' | 'degraded'): ChildProcess {
  return spawn(process.execPath, ['test/e2e/stub-ce.ts', '--port', String(STUB_PORT), '--mode', mode], {
    stdio: 'ignore',
  });
}

function startWeb(): ChildProcess {
  return spawn(process.execPath, ['server.js'], {
    cwd: '.next/standalone',
    stdio: 'ignore',
    env: {
      ...process.env,
      WITHE_DB_PATH: dbPath,
      WITHE_CONFIG: join(work, 'none.yaml'),
      WITHE_CE_URL: `http://127.0.0.1:${STUB_PORT}`,
      WITHE_CE_TOKEN: 'e2e-token',
      WITHE_CE_ORGS: 'acme',
      HOSTNAME: '127.0.0.1',
      PORT: String(WEB_PORT),
    },
  });
}

async function waitFor(path: string, accept: (status: number) => boolean): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    try {
      const r = await fetch(`${WEB}${path}`);
      if (accept(r.status)) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${path} never became ready`);
}

function syncOnce(): void {
  execFileSync(process.execPath, ['src/worker/main.ts', '--once'], {
    env: {
      ...process.env,
      WITHE_DB_PATH: dbPath,
      WITHE_CONFIG: join(work, 'none.yaml'),
      WITHE_CE_URL: `http://127.0.0.1:${STUB_PORT}`,
      WITHE_CE_TOKEN: 'e2e-token',
      WITHE_CE_ORGS: 'acme',
    },
    stdio: 'ignore',
  });
}

function aRunIdFor(fullName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `select rr.id as id from renovate_run rr join repo r on r.id = rr.repo_id
         where r.full_name = ? order by rr.completed_at desc limit 1`,
      )
      .get(fullName) as { id: number } | undefined;
    if (!row) throw new Error(`no run for ${fullName}`);
    return row.id;
  } finally {
    db.close();
  }
}

const allViolations: { page: string; violations: A11yResult['violations'] }[] = [];

async function main(): Promise<void> {
  // --- healthy: sync real data, then walk the operator's flows -------------
  let stub = startStub('healthy');
  let web: ChildProcess | null = null;
  try {
    await waitStub();
    syncOnce();
    const runId = aRunIdFor('acme/lever');

    web = startWeb();
    await waitFor('/api/health', (s) => s === 200 || s === 503);

    // 1. Failure triage — the landing page leads with what is broken.
    const home = readPage('/');
    check(
      'the landing page names the repository that is failing',
      home.includes('acme/lever') && /failing/i.test(home),
      'F-04',
    );
    allViolations.push({ page: '/', violations: (ab(['open', `${WEB}/`]), audit()) });

    // 2. Repository inventory — every repository Renovate knows about.
    const repos = readPage('/repos');
    const repoCount = Number(ab(['get', 'count', 'tbody tr']).trim()) || 0;
    check(
      'the inventory lists every repository',
      repos.includes('acme/lever') && repos.includes('acme/sprocket') && repoCount >= 8,
      `${repoCount} rows`,
    );
    allViolations.push({ page: '/repos', violations: audit() });

    // 3. Run history — a repository's runs, newest first.
    const history = readPage('/repos/acme/lever');
    check(
      "a repository's run history is shown",
      /run|history/i.test(history) && (history.includes('success') || history.includes('failed')),
      'F-05',
    );
    allViolations.push({ page: '/repos/acme/lever', violations: audit() });

    // 4. Log viewer — the run log, streamed from the source through the proxy.
    const log = readPage(`/runs/${runId}`);
    check(
      'the log viewer renders the run log from the source',
      log.includes('Renovate started') || /renovate/i.test(log),
      'F-06',
    );
    allViolations.push({ page: `/runs/${runId}`, violations: audit() });

    // NFR-18: keyboard navigation reaches the controls in a sensible order.
    ab(['open', `${WEB}/`]);
    ab(['wait', '--load', 'networkidle']);
    ab(['press', 'Tab']);
    const focus = ab(['eval', 'document.activeElement && (document.activeElement.tagName + " " + (document.activeElement.textContent||"").slice(0,40))']);
    check(
      'keyboard focus lands on an interactive control',
      /\b(A|BUTTON|INPUT|SELECT)\b/.test(focus),
      focus.replace(/\s+/g, ' ').trim().slice(0, 60),
    );
  } finally {
    if (web) {
      web.kill('SIGTERM');
      await once(web, 'exit').catch(() => {});
    }
    stub.kill('SIGTERM');
    await once(stub, 'exit').catch(() => {});
  }

  // --- degraded: preflight names the exact missing variable ----------------
  stub = startStub('degraded');
  web = startWeb();
  try {
    await waitStub();
    await waitFor('/preflight', (s) => s === 200);
    const preflight = readPage('/preflight');
    check(
      'preflight names the missing variable when the API is off',
      preflight.includes('MEND_RNV_API_ENABLE_REPORTING'),
      'F-01, the fatal inventory probe',
    );
    allViolations.push({ page: '/preflight', violations: audit() });
  } finally {
    web.kill('SIGTERM');
    await once(web, 'exit').catch(() => {});
    stub.kill('SIGTERM');
    await once(stub, 'exit').catch(() => {});
    ab(['close', '--all']);
    rmSync(work, { recursive: true, force: true });
  }

  // --- accessibility verdict, across every page ----------------------------
  const withViolations = allViolations.filter((p) => p.violations.length > 0);
  for (const p of withViolations) reportViolations(p.page, p.violations);
  check(
    'every page meets WCAG 2.1 AA (no contrast or structural violations)',
    withViolations.length === 0,
    withViolations.length > 0 ? `${withViolations.length} page(s) with violations` : '',
  );

  console.log(failures === 0 ? '\ne2e: every flow passed' : `\ne2e: ${failures} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

async function waitStub(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${STUB_PORT}/system/v1/status`, { headers: { authorization: 'Bearer x' } });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('stub never started');
}

await main();
