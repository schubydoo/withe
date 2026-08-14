/**
 * NFR-9, measured: the only place Withe sends a packet is its configured
 * source (Task 3.6's last criterion).
 *
 * "There is no telemetry" is a negative a developer satisfies by not writing
 * any, while a transitive dependency phones home unnoticed. This runs the
 * container on an isolated network with one stand-in source, captures every
 * packet from inside its own network namespace, and reports the destinations.
 *
 * The run ends by making one deliberate call to an address that is not the
 * source, and requires it to appear. A capture that cannot see a leak is not
 * evidence that there was none.
 *
 *   npm run check:network -- withe:dev
 */
import { execFileSync } from 'node:child_process';

const IMAGE = process.argv[2] ?? 'withe:dev';
const NETWORK = 'withe-network-check';
const SOURCE = 'withe-network-check-source';
const WITHE = 'withe-network-check';
const MONITOR = 'withe-network-check-monitor';
const VOLUME = 'withe-network-check-data';
/** Long enough for the monitor to attach before the first packet. */
const STARTUP_DELAY_SECONDS = 20;
const SYNC_INTERVAL_SECONDS = 15;
const SOURCE_PORT = 7623;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function shell(command: string): string {
  return execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim();
}

function quiet(args: string[]): void {
  try {
    // stderr is captured rather than inherited: removing something that was
    // never created is the normal first-run case, and the daemon's complaint
    // about it reads like a failure.
    execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // Absent already, which is the state this wanted.
  }
}

function cleanup(): void {
  for (const name of [MONITOR, WITHE, SOURCE]) quiet(['rm', '-f', name]);
  quiet(['volume', 'rm', '-f', VOLUME]);
  quiet(['network', 'rm', NETWORK]);
}

/** Every address the container sent a packet to, loopback excluded. */
function destinations(): string[] {
  const out = docker([
    'exec', MONITOR, 'sh', '-c',
    `awk '$3 == "Out" {print $7}' /capture.txt | tr -d ':' | sed 's/\\.[0-9]*$//' | grep -v '^127\\.' | sort -u`,
  ]);
  return out === '' ? [] : out.split('\n');
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

cleanup();
try {
  docker(['network', 'create', NETWORK]);
  docker(['volume', 'create', VOLUME]);

  // A stand-in for Renovate CE. It answers 404 to everything, which is enough
  // to make Withe's client talk to it.
  docker([
    'run', '-d', '--name', SOURCE, '--network', NETWORK, 'busybox:latest',
    'sh', '-c', `mkdir -p /www && httpd -f -p ${SOURCE_PORT} -h /www`,
  ]);
  const sourceIp = docker([
    'inspect', SOURCE, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
  ]);

  // The entrypoint waits, so the capture starts before Withe's first packet.
  docker([
    'run', '-d', '--name', WITHE, '--network', NETWORK,
    '-v', `${VOLUME}:/data`,
    '-e', `WITHE_CE_URL=http://${SOURCE}:${SOURCE_PORT}`,
    '-e', 'WITHE_CE_TOKEN=network-check',
    '-e', `WITHE_SYNC_INTERVAL_SECONDS=${SYNC_INTERVAL_SECONDS}`,
    '--entrypoint', '/sbin/tini', IMAGE,
    '--', 'sh', '-c', `sleep ${STARTUP_DELAY_SECONDS}; exec node dist/supervisor.js`,
  ]);

  // Inside Withe's own network namespace: it sees exactly what Withe sends,
  // and nothing from any other container.
  docker([
    'run', '-d', '--name', MONITOR, '--network', `container:${WITHE}`,
    '--cap-add', 'NET_RAW', '--cap-add', 'NET_ADMIN', 'alpine:latest',
    'sh', '-c', 'apk add --no-cache tcpdump > /dev/null 2>&1 && tcpdump -n -q -l -i any ip or ip6 > /capture.txt 2>/dev/null',
  ]);

  shell(`until docker exec ${MONITOR} pgrep tcpdump > /dev/null 2>&1; do sleep 1; done`);
  console.log(`monitoring ${WITHE}; the source is ${sourceIp}:${SOURCE_PORT}`);

  // Startup, preflight, and at least two sync cycles.
  shell(
    `until docker logs ${WITHE} 2>&1 | grep -q 'watching'; do sleep 2; done`,
  );
  await sleep(SYNC_INTERVAL_SECONDS * 2);

  const seen = destinations();
  check(
    'the only address Withe sent to is its configured source',
    seen.length === 1 && seen[0] === sourceIp,
    seen.length === 0 ? 'nothing was captured at all' : seen.join(', '),
  );

  const packets = docker(['exec', MONITOR, 'sh', '-c', 'wc -l < /capture.txt']);
  check('the capture is not empty, so a clean result means something', Number(packets) > 10, `${packets} packets`);

  // Prove the instrument. One call to an address that is not the source must
  // show up, or the check above was measuring nothing.
  const gateway = docker([
    'inspect', WITHE, '--format', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}',
  ]);
  docker(['exec', WITHE, 'sh', '-c', `wget -q -T 3 -O- http://${gateway}:9/ > /dev/null 2>&1 || true`]);
  await sleep(3);
  const after = destinations();
  check(
    'a deliberate call to another address is caught',
    after.includes(gateway),
    `planted ${gateway}:9, saw ${after.join(', ')}`,
  );
} finally {
  cleanup();
}

if (failures.length > 0) {
  console.error(`\nnetwork: ${failures.length} checks failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nnetwork: Withe talked to its source and to nothing else');
}
