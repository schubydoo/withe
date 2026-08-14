/**
 * Render every page with a known token configured, and prove the token is not
 * in what the browser receives (NFR-8, Task 3.4).
 *
 * React serializes Server Component props into the client payload. A page that
 * passes a configuration object down — or a value derived from one — leaks the
 * token into HTML that looks perfectly ordinary, because the leak is in the
 * RSC flight data below the markup rather than in the markup itself. Reading
 * the page does not find this. Searching the whole response does.
 *
 * A script rather than a `node --test` file: it needs the production build,
 * which takes longer than a unit test should, and it starts a real server.
 * `checkBody` is exported and tested on its own.
 *
 *   npm run build && npm run check:payloads
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';

/** Values planted in the environment before the server starts. */
export const PLANTED = {
  token: 'planted-ce-token-8f21c4a97b3e',
  authPass: 'planted-auth-password-4d7e',
};

export interface Leak {
  route: string;
  secret: string;
}

/** Every planted value that appears anywhere in one response. */
export function checkBody(route: string, body: string, secrets: readonly string[]): Leak[] {
  return secrets.filter((secret) => body.includes(secret)).map((secret) => ({ route, secret }));
}

const SERVER = '.next/standalone/server.js';
const PORT = 31_337;

async function main(): Promise<void> {
  if (!existsSync(SERVER)) {
    console.error(`payloads: ${SERVER} does not exist. Run npm run build first.`);
    process.exit(2);
  }

  const database = process.env.WITHE_DB_PATH;
  if (!database || !existsSync(database)) {
    console.error(
      'payloads: set WITHE_DB_PATH to a populated database. ' +
        'An empty one renders empty pages, which prove nothing.',
    );
    process.exit(2);
  }

  const server = start(database);
  const leaks: Leak[] = [];
  let count = 0;
  try {
    await waitForPort();
    const routes = await discoverRoutes();
    count = routes.length;

    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${PORT}${route}`, { redirect: 'follow' });
      const body = await response.text();
      leaks.push(...checkBody(route, body, [PLANTED.token, PLANTED.authPass]));
      console.log(`payloads: ${route} → ${response.status}, ${body.length} bytes`);
    }
  } finally {
    // Before reporting, not after. The child inherits stdout, so a script that
    // exits while it lives leaves the pipe open and whatever reads this hangs
    // — and `process.exit` does not run a `finally` block.
    server.kill('SIGTERM');
    await once(server, 'exit');
  }

  if (leaks.length > 0) {
    for (const leak of leaks) console.error(`payloads: ${leak.route} contains ${leak.secret}`);
    process.exitCode = 1;
    return;
  }
  console.log(`payloads: ${count} routes, no configured secret in any response`);
}

function start(database: string): ChildProcess {
  return spawn(process.execPath, ['server.js'], {
    cwd: '.next/standalone',
    stdio: 'inherit',
    env: {
      ...process.env,
      WITHE_DB_PATH: database,
      WITHE_CE_URL: 'http://127.0.0.1:1',
      WITHE_CE_TOKEN: PLANTED.token,
      // Auth stays off. With it on every route answers 401 and the scan reads
      // the same eleven words each time.
      WITHE_AUTH_USER: '',
      WITHE_AUTH_PASS: '',
      WITHE_BIND: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      PORT: String(PORT),
    },
  });
}

async function waitForPort(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/preflight`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`the server did not answer on ${PORT}`);
}

/**
 * The fixed pages, plus one of each dynamic route taken from the rendered
 * inventory. A dynamic route with no id is a route this scan never covers.
 */
async function discoverRoutes(): Promise<string[]> {
  // The export endpoint returns the whole database; it must never carry a token.
  const routes = ['/', '/repos', '/preflight', '/api/export'];

  const repos = await (await fetch(`http://127.0.0.1:${PORT}/repos`)).text();
  const repoHref = /href="(\/repos\/[^"]+\/[^"]+)"/.exec(repos)?.[1];
  if (repoHref) routes.push(repoHref);

  const home = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  const runHref = /href="(\/runs\/\d+)"/.exec(home)?.[1] ?? (repoHref ? await runFrom(repoHref) : null);
  if (runHref) {
    routes.push(runHref);
    // The log proxy answers from the source rather than the database, so it is
    // the one route whose body Withe did not compose.
    routes.push(`/api/runs/${runHref.split('/').pop()}/log`);
  }

  return routes;
}

async function runFrom(repoHref: string): Promise<string | null> {
  const page = await (await fetch(`http://127.0.0.1:${PORT}${repoHref}`)).text();
  return /href="(\/runs\/\d+)"/.exec(page)?.[1] ?? null;
}

// Run directly, not when imported by the tests.
if (process.argv[1]?.endsWith('check-payloads.ts')) await main();
