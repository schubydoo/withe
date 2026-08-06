import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { restartDelayMs, Supervisor } from './children.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-sup-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A real child process, because supervision is what must not be mocked. */
function script(name: string, body: string): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}

const LIVES_FOREVER = script(
  'forever',
  `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1 << 30);`,
);

const EXITS_AT_ONCE = script('crash', `process.exit(3);`);

const IGNORES_SIGTERM = script(
  'stubborn',
  `process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);`,
);

const COUNTS_STARTS = (counter: string) =>
  script(
    'counter',
    `import { appendFileSync } from 'node:fs';
     appendFileSync(${JSON.stringify(counter)}, 'x');
     process.exit(1);`,
  );

function child(name: string, path: string) {
  return { name, command: process.execPath, args: [path] };
}

test('restart delay doubles and stops at the cap', () => {
  assert.equal(restartDelayMs(0, 60_000), 0);
  assert.equal(restartDelayMs(1, 60_000), 1_000);
  assert.equal(restartDelayMs(2, 60_000), 2_000);
  assert.equal(restartDelayMs(7, 60_000), 60_000, 'capped at sixty seconds');
  assert.equal(restartDelayMs(50, 60_000), 60_000, 'never overflows past the cap');
});

test('both children start, and one crashing does not stop the other', { timeout: 10_000 }, async () => {
  const logged: string[] = [];
  const sup = new Supervisor(
    [child('web', LIVES_FOREVER), child('worker', EXITS_AT_ONCE)],
    { log: (m) => logged.push(m), maxConsecutiveFailures: 99, maxBackoffMs: 20, healthyAfterMs: 1 },
  );

  const done = sup.run();
  await wait(300);

  assert.ok(sup.running.includes('web'), 'the healthy child must survive its sibling crashing');
  assert.ok(logged.some((m) => /worker exited with code 3/.test(m)));

  sup.shutdown('SIGTERM');
  assert.equal(await done, 0);
});

test('a crashed child is restarted, and each restart is logged', { timeout: 10_000 }, async () => {
  const counter = join(dir, 'starts.txt');
  writeFileSync(counter, '');
  const logged: string[] = [];

  const sup = new Supervisor([child('worker', COUNTS_STARTS(counter))], {
    log: (m) => logged.push(m),
    maxConsecutiveFailures: 99,
    maxBackoffMs: 10,
    healthyAfterMs: 1,
  });

  const done = sup.run();
  await wait(400);
  sup.shutdown('SIGTERM');
  await done;

  const starts = (await import('node:fs')).readFileSync(counter, 'utf8').length;
  assert.ok(starts >= 3, `expected several restarts, saw ${starts}`);
  assert.ok(logged.filter((m) => /restart \d+ in/.test(m)).length >= 2);
});

test('three consecutive failures give up with a non-zero exit', { timeout: 10_000 }, async () => {
  const logged: string[] = [];
  const sup = new Supervisor([child('worker', EXITS_AT_ONCE)], {
    log: (m) => logged.push(m),
    maxConsecutiveFailures: 3,
    maxBackoffMs: 5,
    // Large on purpose: a child that dies immediately must never count as
    // recovered, or the failure counter resets and the give-up path is
    // unreachable. Setting this to 1 made the supervisor restart forever.
    healthyAfterMs: 60_000,
    drainMs: 100,
  });

  const code = await sup.run();
  assert.equal(code, 1, 'the container restart policy should take over, not a broken image sitting up');
  assert.ok(logged.some((m) => /failed 3 times in a row/.test(m)));
});

test('a child that stays up long enough clears its failure count', { timeout: 10_000 }, async () => {
  const logged: string[] = [];
  // healthyAfterMs is 0, so every run counts as recovered and the third crash
  // is still failure number one. Without the reset this would give up.
  const sup = new Supervisor([child('worker', EXITS_AT_ONCE)], {
    log: (m) => logged.push(m),
    maxConsecutiveFailures: 3,
    maxBackoffMs: 5,
    healthyAfterMs: 0,
  });

  const done = sup.run();
  await wait(300);
  assert.ok(!logged.some((m) => /Giving up/.test(m)), 'an uptime reset must prevent giving up');
  sup.shutdown('SIGTERM');
  await done;
});

test('SIGTERM reaches every child and the supervisor exits', { timeout: 10_000 }, async () => {
  const sup = new Supervisor(
    [child('web', LIVES_FOREVER), child('worker', LIVES_FOREVER)],
    { drainMs: 2000, healthyAfterMs: 1 },
  );

  const done = sup.run();
  await wait(200);
  assert.equal(sup.running.length, 2);

  const started = Date.now();
  sup.shutdown('SIGTERM');
  assert.equal(await done, 0);
  assert.ok(Date.now() - started < 1500, 'it must not wait out the drain when children leave promptly');
  assert.equal(sup.running.length, 0);
});

test('a child ignoring SIGTERM is killed after the drain', { timeout: 10_000 }, async () => {
  const logged: string[] = [];
  const sup = new Supervisor([child('stubborn', IGNORES_SIGTERM)], {
    drainMs: 250,
    healthyAfterMs: 1,
    log: (m) => logged.push(m),
  });

  const done = sup.run();
  await wait(200);
  sup.shutdown('SIGTERM');

  assert.equal(await done, 0);
  assert.ok(logged.some((m) => /did not stop in time, killing it/.test(m)));
});

test('a child is not restarted once shutdown has begun', { timeout: 10_000 }, async () => {
  const counter = join(dir, 'starts2.txt');
  writeFileSync(counter, '');
  const sup = new Supervisor([child('worker', COUNTS_STARTS(counter))], {
    maxConsecutiveFailures: 99,
    maxBackoffMs: 5,
    healthyAfterMs: 1,
    drainMs: 100,
    log: () => {},
  });

  const done = sup.run();
  await wait(100);
  sup.shutdown('SIGTERM');
  await done;

  const { readFileSync } = await import('node:fs');
  const before = readFileSync(counter, 'utf8').length;
  await wait(200);
  assert.equal(readFileSync(counter, 'utf8').length, before, 'no restart may happen after shutdown');
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
