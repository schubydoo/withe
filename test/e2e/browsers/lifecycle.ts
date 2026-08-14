/**
 * Shared start/stop for the browser smoke: stub CE, one real sync, web server.
 * The state file lets global-teardown reach the processes global-setup started.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const STUB_PORT = 7733;
export const WEB_PORT = 31_380;
export const STATE_FILE = join(tmpdir(), 'withe-pw-state.json');

export interface State {
  stubPid: number;
  webPid: number;
  work: string;
}

export function startStack(): State {
  const work = mkdtempSync(join(tmpdir(), 'withe-pw-'));
  const dbPath = join(work, 'e2e.db');
  const env = {
    ...process.env,
    WITHE_DB_PATH: dbPath,
    WITHE_CONFIG: join(work, 'none.yaml'),
    WITHE_CE_URL: `http://127.0.0.1:${STUB_PORT}`,
    WITHE_CE_TOKEN: 'e2e-token',
    WITHE_CE_ORGS: 'acme',
  };

  const stub = spawn(
    process.execPath,
    ['test/e2e/stub-ce.ts', '--port', String(STUB_PORT), '--mode', 'healthy'],
    { stdio: 'ignore', detached: true },
  );
  stub.unref();

  // A real sync, so the pages render real rows. Blocking on purpose.
  execFileSync(process.execPath, ['src/worker/main.ts', '--once'], { env, stdio: 'ignore' });

  const web = spawn(process.execPath, ['server.js'], {
    cwd: '.next/standalone',
    stdio: 'ignore',
    detached: true,
    env: { ...env, HOSTNAME: '127.0.0.1', PORT: String(WEB_PORT) },
  });
  web.unref();

  return { stubPid: stub.pid ?? 0, webPid: web.pid ?? 0, work };
}
