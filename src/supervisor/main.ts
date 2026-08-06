/**
 * PID 1's child. Migrates, then keeps `web` and `worker` alive.
 *
 * `tini` is PID 1 in the image and reaps zombies; this process owns the
 * children and the signals. Migrating here rather than in either child
 * guarantees a single migrator and removes the start-order race.
 */
import { ConfigError, loadConfig } from '../config/load.ts';
import { clearMigrationAttempts, migrateOnce, MigrationGaveUpError } from './migrate.ts';
import { Supervisor, type ChildSpec } from './children.ts';

// Load configuration before migrating. A bad setting should be reported by
// name rather than surfacing later as a child that will not start.
let file: string;
try {
  const config = loadConfig();
  file = config.dbPath;
  for (const warning of config.warnings) console.warn(`configuration: ${warning}`);
} catch (cause) {
  if (cause instanceof ConfigError) {
    console.error(`configuration: ${cause.message}`);
    process.exit(2);
  }
  throw cause;
}

try {
  migrateOnce(file);
  clearMigrationAttempts(file);
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

const children: ChildSpec[] = [
  { name: 'web', command: webCommand[0] as string, args: webCommand.slice(1) },
  { name: 'worker', command: workerCommand[0] as string, args: workerCommand.slice(1) },
];

const supervisor = new Supervisor(children, {
  log: (message) => console.log(message),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => supervisor.shutdown(signal));
}

process.exit(await supervisor.run());
