/**
 * The container HEALTHCHECK's exit code, tested end to end.
 *
 * healthcheck.ts is a script, not a module: it probes /api/health on import
 * and exits. So it is spawned the way the Dockerfile spawns it, and the exit
 * code is the whole contract — 0 for a 200, 1 for anything else. These runs
 * happen in a child process, so this file keeps the script honest without
 * appearing in the in-process coverage report.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./healthcheck.ts', import.meta.url));

let server: Server;
let port = 0;
let status = 200;

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(req.url === '/api/health' ? status : 404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

after(() => server.close());

async function exitCode(targetPort: number): Promise<number | null> {
  const child = spawn(process.execPath, [script], {
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PATH: process.env.PATH,
      // Pin the answers the script would otherwise probe for, so the machine
      // running the tests cannot change what is being tested.
      WITHE_CONFIG: join(tmpdir(), 'withe-healthcheck-absent.yaml'),
      WITHE_IN_CONTAINER: 'false',
      WITHE_BIND: '127.0.0.1',
      WITHE_PORT: String(targetPort),
    },
    stdio: 'ignore',
  });
  const [code] = (await once(child, 'exit')) as [number | null, string | null];
  return code;
}

test('a 200 from /api/health exits 0, so Docker calls the container healthy', async () => {
  status = 200;
  assert.equal(await exitCode(port), 0);
});

test('a 503 exits 1 — a stale worker is unhealthy even though HTTP answered', async () => {
  status = 503;
  assert.equal(await exitCode(port), 1);
});

test('nothing listening at all exits 1 rather than hanging', async () => {
  // A port that was just released: connecting is refused immediately.
  const parked = createServer();
  await new Promise<void>((resolve) => parked.listen(0, '127.0.0.1', resolve));
  const address = parked.address();
  const free = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => parked.close(() => resolve()));

  assert.equal(await exitCode(free), 1);
});
