/**
 * Two processes on one SQLite file, under load (Task 3.9, tad.md risk TR-1).
 *
 * TR-1 is rated the highest technical risk: a long sync transaction blocks
 * readers past `busy_timeout`, and pages start failing. The mitigation is WAL
 * mode, `busy_timeout = 5000`, exactly one writer, and a sync transaction
 * scoped per source. This measures whether that holds at 500 repositories.
 *
 * The shape is deliberately the real one: a standalone web server reads the
 * file while a separate writer process calls `persist()` — the same
 * per-source transaction the worker runs — over and over. A load driver hits
 * the two heaviest pages throughout and records every status and latency. It
 * passes only if no request failed on a locked database and the worst reader
 * wait stayed under the 5 s timeout.
 *
 *   npm run build && npm run check:contention
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { CollectResult } from '../src/adapters/types.ts';
import type { RenovateRun, Repo, Update } from '../src/core/model.ts';
import { openDatabase } from '../src/db/client.ts';
import { persist } from '../src/db/persist.ts';
import { generate } from './perf-dataset.ts';

const REPOS = 500;
const RUNS_PER_REPO = 30;
const UPDATES_PER_REPO = 6;
const WRITER_ITERATIONS = 20;
const READERS = 8;
const PORT = 31_358;
const NOW = 1_786_000_000_000;
const BUSY_TIMEOUT_MS = 5000;

/** The 500-repo sync result the writer persists each iteration. */
function collectResult(): CollectResult {
  const repos: Repo[] = [];
  const runs: RenovateRun[] = [];
  const updates: Update[] = [];

  for (let i = 0; i < REPOS; i += 1) {
    const org = `org${i % 12}`;
    const name = `service-${String(i).padStart(4, '0')}`;
    const repoId = `default:${org}/${name}`;
    repos.push({
      id: repoId,
      org,
      name,
      fullName: `${org}/${name}`,
      enabled: true,
      installStatus: 'activated',
      queueName: 'main',
      installedAt: null,
      removedAt: null,
      sourceAdapterId: 'default',
    });

    for (let r = 0; r < RUNS_PER_REPO; r += 1) {
      runs.push({
        id: `default:job-${i}-${r}`,
        repoId,
        externalJobId: `job-${i}-${r}`,
        triggerReason: 'schedule-all',
        queuedAt: new Date(NOW - r * 3_600_000),
        startedAt: new Date(NOW - r * 3_600_000),
        completedAt: new Date(NOW - r * 3_600_000),
        status: 'success',
        error: null,
        artifactErrors: [],
        logLocation: `jobs/job-${i}-${r}`,
        runnerVersion: '43.280.0',
        sourceAdapterId: 'default',
      });
    }

    for (let u = 0; u < UPDATES_PER_REPO; u += 1) {
      updates.push({
        id: `default:${org}/${name}:pkg-${u}`,
        repoId,
        dependencyName: `@scope/pkg-${u}`,
        currentVersion: `1.${u}.0`,
        targetVersion: `1.${u}.1`,
        updateType: 'minor',
        datasource: 'npm',
        packageName: `@scope/pkg-${u}`,
        state: 'detected',
        pullRequestUrl: null,
        pullRequestNumber: null,
        closedAt: null,
        closeType: null,
        detectedAt: new Date(NOW),
        packageFileCount: 1,
        packageFiles: [`packages/pkg-${u}/package.json`],
        sourceAdapterId: 'default',
      });
    }
  }

  return { repos, runs, updates, warnings: [] };
}

/** Writer process: persist the whole 500-repo set, WRITER_ITERATIONS times. */
function runWriter(dbPath: string): void {
  const { sqlite, db } = openDatabase(dbPath, { role: 'owner' });
  const result = collectResult();
  const perIteration: number[] = [];
  let busyErrors = 0;

  for (let i = 0; i < WRITER_ITERATIONS; i += 1) {
    const t = performance.now();
    try {
      persist(db, 'default', 'ce', result, new Date());
    } catch (cause) {
      if (/SQLITE_BUSY|database is locked/i.test(String(cause))) busyErrors += 1;
      else throw cause;
    }
    perIteration.push(performance.now() - t);
  }
  sqlite.close();

  const sorted = [...perIteration].sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      iterations: WRITER_ITERATIONS,
      busyErrors,
      transactionP50Ms: sorted[Math.floor(sorted.length * 0.5)],
      transactionMaxMs: sorted[sorted.length - 1],
    }) + '\n',
  );
}

interface Sample {
  status: number;
  ms: number;
  path: string;
}

async function driveReaders(deadline: () => boolean): Promise<Sample[]> {
  const paths = ['/', '/repos'];
  const samples: Sample[] = [];

  async function worker(seed: number): Promise<void> {
    let n = seed;
    while (!deadline()) {
      const path = paths[n % paths.length] as string;
      n += 1;
      const t = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
        await response.text();
        samples.push({ status: response.status, ms: performance.now() - t, path });
      } catch {
        samples.push({ status: 0, ms: performance.now() - t, path });
      }
    }
  }

  await Promise.all(Array.from({ length: READERS }, (_unused, i) => worker(i)));
  return samples;
}

function startServer(dbPath: string, work: string): ChildProcess {
  return spawn(process.execPath, ['server.js'], {
    cwd: '.next/standalone',
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      WITHE_DB_PATH: dbPath,
      WITHE_CONFIG: join(work, 'none.yaml'),
      WITHE_CE_URL: 'http://127.0.0.1:1',
      WITHE_CE_TOKEN: 'contention',
      HOSTNAME: '127.0.0.1',
      PORT: String(PORT),
    },
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.status === 200 || r.status === 503) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

// --- writer mode, run as a child ------------------------------------------
if (process.argv[2] === '--writer') {
  runWriter(process.argv[3] as string);
} else if (process.argv[1]?.endsWith('check-contention.ts')) {
  const work = mkdtempSync(join(tmpdir(), 'withe-contention-'));
  const dbPath = join(work, 'contention.db');
  generate(dbPath, REPOS, NOW);

  const server = startServer(dbPath, work);
  let writer: ChildProcess | null = null;
  try {
    await waitForServer();

    // The writer runs to completion; the readers hammer until it exits.
    let writerDone = false;
    writer = spawn(process.execPath, [process.argv[1] as string, '--writer', dbPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let writerReport = '';
    writer.stdout?.on('data', (chunk: Buffer) => (writerReport += chunk.toString()));
    void once(writer, 'exit').then(() => {
      writerDone = true;
    });

    const started = performance.now();
    const samples = await driveReaders(() => writerDone);
    const elapsed = performance.now() - started;

    const failures = samples.filter((s) => s.status !== 200);
    const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
    const max = latencies[latencies.length - 1] ?? 0;
    const wr = writerReport.trim() ? JSON.parse(writerReport.trim()) : {};

    console.log('\n--- Task 3.9 contention, 500 repos, two processes on one file ---\n');
    console.log(`writer: ${wr.iterations} persist cycles, ${wr.busyErrors} busy errors, ` +
      `transaction p50 ${Math.round(wr.transactionP50Ms)} ms, max ${Math.round(wr.transactionMaxMs)} ms`);
    console.log(`readers: ${samples.length} requests over ${(elapsed / 1000).toFixed(1)} s, ` +
      `${READERS} concurrent, across / and /repos`);
    console.log(`reader latency: p95 ${Math.round(p95)} ms, max ${Math.round(max)} ms`);
    console.log(`reader failures: ${failures.length}`);

    const passed = failures.length === 0 && max < BUSY_TIMEOUT_MS && (wr.busyErrors ?? 0) === 0;
    console.log(
      `\n${passed ? 'ok  ' : 'FAIL'}  no request failed on a locked database, ` +
        `worst reader wait ${Math.round(max)} ms < ${BUSY_TIMEOUT_MS} ms busy_timeout`,
    );
    if (!passed) {
      for (const f of failures.slice(0, 5)) console.error(`  ${f.path} -> ${f.status} in ${Math.round(f.ms)} ms`);
      process.exitCode = 1;
    }
  } finally {
    if (writer && writer.exitCode === null) writer.kill('SIGKILL');
    server.kill('SIGTERM');
    await once(server, 'exit');
    rmSync(work, { recursive: true, force: true });
  }
}
