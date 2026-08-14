/**
 * PID 1's child. Migrates, then keeps `web` and `worker` alive.
 *
 * `tini` is PID 1 in the image and reaps zombies; this process owns the
 * children and the signals. Migrating here rather than in either child
 * guarantees a single migrator and removes the start-order race.
 */
import { ConfigError, loadConfig, type WitheConfig } from '../config/load.ts';
import { clearMigrationAttempts, migrateOnce, MigrationGaveUpError } from './migrate.ts';
import { Supervisor, type ChildSpec } from './children.ts';

// Load configuration before migrating. A bad setting should be reported by
// name rather than surfacing later as a child that will not start.
let config: WitheConfig;
try {
  config = loadConfig();
  for (const warning of config.warnings) console.warn(`configuration: ${warning}`);
} catch (cause) {
  if (cause instanceof ConfigError) {
    console.error(`configuration: ${cause.message}`);
    process.exit(2);
  }
  throw cause;
}

try {
  migrateOnce(config.dbPath);
  clearMigrationAttempts(config.dbPath);
} catch (cause) {
  if (cause instanceof MigrationGaveUpError) {
    // Exit 2 rather than 1: a restart cannot help, and the message names the
    // file to read and the backup to restore.
    console.error(cause.message);
    process.exit(2);
  }
  console.error(`supervisor: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}

// In the image the working directory is the standalone build and `server.js`
// sits beside it. Outside the image there is no such file, so the command is
// overridable — otherwise the only way to exercise this code is to build a
// container, and code that can only be tested in a container does not get
// tested.
const webCommand = (process.env.WITHE_WEB_CMD ?? `${process.execPath} server.js`).split(' ');
const workerCommand = (
  process.env.WITHE_WORKER_CMD ?? `${process.execPath} src/worker/main.ts`
).split(' ');
const tlsCommand = (
  process.env.WITHE_TLS_CMD ?? `${process.execPath} src/tls-proxy/main.ts`
).split(' ');

const children: ChildSpec[] = [
  {
    name: 'web',
    command: webCommand[0] as string,
    args: webCommand.slice(1),
    // NFR-13. The standalone server takes its listen address from these two
    // variables, and the supervisor is the only process that knows what the
    // configuration decided, so it sets them rather than trusting whatever the
    // environment happened to carry. Behind TLS these are loopback and one
    // port up, and the proxy takes the configured address.
    env: { HOSTNAME: config.webBind, PORT: String(config.webPort) },
    // The standalone server resolves its assets relative to where it runs.
    ...(process.env.WITHE_WEB_CWD ? { cwd: process.env.WITHE_WEB_CWD } : {}),
  },
  { name: 'worker', command: workerCommand[0] as string, args: workerCommand.slice(1) },
];

// AD-2. Only when the operator supplied both paths; there is nothing to
// terminate otherwise.
if (config.tls) {
  children.push({
    name: 'tls-proxy',
    command: tlsCommand[0] as string,
    args: tlsCommand.slice(1),
  });
}

console.log(
  `supervisor: web will listen on ${config.webBind}:${config.webPort}` +
    `${config.tls ? `, behind TLS on ${config.bind}:${config.port}` : ''}` +
    `${config.container ? ' (container detected)' : ''}`,
);

const supervisor = new Supervisor(children, {
  log: (message) => console.log(message),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => supervisor.shutdown(signal));
}

process.exit(await supervisor.run());
