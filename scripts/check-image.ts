/**
 * Verify the container image against Task 3.5's criteria, on a real daemon.
 *
 * Every check here exists because the thing it tests fails silently or fails
 * late: a build toolchain that survives into the runner is invisible until
 * someone looks; a `/data` owned by root fails only on a clean host's first
 * run; a missing `libstdc++` fails at import rather than at build; and a
 * dependency the bundler dropped fails only when a YAML config is used.
 *
 *   npm run build && npm run bundle:server
 *   docker build -t withe:dev .
 *   npm run check:image -- withe:dev
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMAGE = process.argv[2] ?? 'withe:dev';
const CONTAINER = 'withe-image-check';
const VOLUME = 'withe-image-check-data';
const PORT = 31_340;
const START_BUDGET_MS = 60_000;

const work = mkdtempSync(join(tmpdir(), 'withe-image-'));
const configPath = join(work, 'withe.yaml');
writeFileSync(
  configPath,
  'sources:\n  - id: probe-ce\n    kind: ce\n    url: http://127.0.0.1:7623\n    tokenEnv: WITHE_CE_TOKEN\n',
);

/** A row in every table the run pages read, written through the image's own copy of better-sqlite3. */
const seedPath = join(work, 'seed.mjs');
writeFileSync(
  seedPath,
  `import Database from 'better-sqlite3';
const db = new Database('/data/withe.db');
db.prepare("insert or replace into source (id, kind) values ('probe-ce', 'ce')").run();
db.prepare("insert or replace into repo (id, source_adapter_id, org, name, full_name, enabled) values (1, 'probe-ce', 'acme', 'widget', 'acme/widget', 1)").run();
db.prepare("insert or replace into renovate_run (id, source_adapter_id, repo_id, external_job_id, status) values (1, 'probe-ce', 1, 'job-1', 'success')").run();
console.log('seeded');
`,
);

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

/**
 * `docker logs` writes a container's stderr to stderr, and Withe's warnings go
 * to `console.warn`. Reading stdout alone finds none of them, which reads as a
 * clean log rather than a lost one.
 */
function dockerLogs(container: string): string {
  return execFileSync('sh', ['-c', `docker logs ${container} 2>&1`], { encoding: 'utf8' });
}

function inspect(format: string): string {
  return docker(['image', 'inspect', '--format', format, IMAGE]);
}

/** Run a command inside the image and return its output, or '' when it fails. */
function inImage(command: string): string {
  try {
    return docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', command]);
  } catch {
    return '';
  }
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function cleanup(): void {
  try {
    docker(['rm', '-f', CONTAINER]);
  } catch {
    // Not running. Nothing to remove.
  }
}

async function reachable(path: string, budgetMs: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (response.ok) return Date.now() - started;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function start(extra: string[]): void {
  cleanup();
  docker([
    'run', '-d', '--name', CONTAINER,
    '-v', `${VOLUME}:/data`,
    '-v', `${configPath}:/config/withe.yaml:ro`,
    '-e', 'WITHE_CONFIG=/config/withe.yaml',
    '-e', 'WITHE_CE_TOKEN=probe-token',
    '-p', `127.0.0.1:${PORT}:3000`,
    ...extra,
    IMAGE,
  ]);
}

try {
  // --- the image itself -----------------------------------------------------
  const bytes = Number(inspect('{{.Size}}'));
  const mb = Math.round(bytes / 1_000_000);
  check('uncompressed size is 300 MB or less', mb <= 300, `${mb} MB on ${inspect('{{.Architecture}}')}`);
  check('runs as node, not root', inspect('{{.Config.User}}') === 'node', inspect('{{.Config.User}}'));
  check('declares a healthcheck', inspect('{{if .Config.Healthcheck}}yes{{end}}') === 'yes', '');
  check('declares the data volume', inspect('{{range $v, $_ := .Config.Volumes}}{{$v}}{{end}}') === '/data', '');

  const toolchain = inImage('command -v gcc g++ cc make python3 node-gyp 2>/dev/null | tr "\\n" " "');
  check('no build toolchain in the runner', toolchain === '', toolchain || 'none of gcc, g++, cc, make, python3');
  const libstdcpp = inImage('ls /usr/lib/libstdc++.so.6 2>/dev/null');
  check('libstdc++ is present for the SQLite addon', libstdcpp !== '', libstdcpp);
  const owner = inImage('stat -c "%U:%G" /data');
  check('/data is owned by node before the volume mounts', owner === 'node:node', owner);

  // --- a clean host: fresh volume, config file, nothing else ----------------
  try {
    docker(['volume', 'rm', '-f', VOLUME]);
  } catch {
    // Not there yet.
  }
  docker(['volume', 'create', VOLUME]);

  start([]);
  const firstRun = await reachable('/preflight', START_BUDGET_MS);
  check(
    'a fresh named volume serves the preflight page within 60 s',
    firstRun !== null,
    firstRun === null ? 'never answered' : `${(firstRun / 1000).toFixed(1)} s`,
  );

  const log = dockerLogs(CONTAINER);
  check(
    'the YAML config was parsed, so the bundled worker has its dependencies',
    log.includes('/config/withe.yaml'),
    'the parser is the dependency standalone output does not trace',
  );
  check(
    'an unreachable source does not stop the container',
    docker(['inspect', '--format', '{{.State.Running}}', CONTAINER]) === 'true',
    'the preflight page exists to explain exactly this',
  );

  // --- the data outlives the container --------------------------------------
  // Into /app, not /tmp: Node resolves `better-sqlite3` by walking up from the
  // file, and only /app has a node_modules to find.
  docker(['cp', seedPath, `${CONTAINER}:/app/seed.mjs`]);
  docker(['exec', CONTAINER, 'node', '/app/seed.mjs']);
  cleanup();
  start([]);
  const afterRecreate = await reachable('/repos', START_BUDGET_MS);
  const repos = afterRecreate === null ? '' : await (await fetch(`http://127.0.0.1:${PORT}/repos`)).text();
  check(
    'run history survives deleting and recreating the container',
    repos.includes('acme') && repos.includes('widget'),
    'the row written before the container was destroyed',
  );

  // --- the documented run flags ---------------------------------------------
  cleanup();
  start(['--read-only', '--tmpfs', '/tmp', '--tmpfs', '/app/.next/cache']);
  const readOnly = await reachable('/preflight', START_BUDGET_MS);
  check(
    'serves the preflight page with --read-only and the two tmpfs mounts',
    readOnly !== null,
    readOnly === null ? dockerLogs(CONTAINER).split('\n').slice(-5).join(' ') : `${(readOnly / 1000).toFixed(1)} s`,
  );
} finally {
  cleanup();
  try {
    docker(['volume', 'rm', '-f', VOLUME]);
  } catch {
    // Already gone.
  }
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nimage: ${failures.length} checks failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nimage: every check passed');
}
