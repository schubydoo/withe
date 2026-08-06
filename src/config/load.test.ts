import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ConfigError, loadConfig } from './load.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-cfg-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function file(body: string): string {
  counter += 1;
  const path = join(dir, `c${counter}.yaml`);
  writeFileSync(path, body);
  return path;
}

/** A path that does not exist, so the flat form is used. */
const NO_FILE = join(dir, 'absent.yaml');

test('flat variables produce one source called default', () => {
  const config = loadConfig({
    WITHE_CONFIG: NO_FILE,
    WITHE_CE_URL: 'http://ce.local',
    WITHE_CE_TOKEN: 'secret',
  });

  assert.deepEqual(config.sources, [
    { id: 'default', kind: 'ce', url: 'http://ce.local', token: 'secret' },
  ]);
  assert.deepEqual(config.warnings, []);
});

test('every documented variable is read, with its documented default', () => {
  const config = loadConfig({ WITHE_CONFIG: NO_FILE });

  assert.equal(config.dbPath, '/data/withe.db');
  assert.equal(config.configPath, NO_FILE);
  assert.equal(config.syncIntervalSeconds, 300);
  assert.equal(config.stalledAfterDays, 7);
  assert.equal(config.retentionDays, null);
  assert.equal(config.auth, null);
  assert.equal(config.tls, null);
  assert.equal(config.bind, '127.0.0.1');
  assert.equal(config.port, 3000);
});

test('every documented variable can be overridden', () => {
  const config = loadConfig({
    WITHE_CONFIG: NO_FILE,
    WITHE_DB_PATH: '/tmp/x.db',
    WITHE_SYNC_INTERVAL_SECONDS: '60',
    WITHE_STALLED_AFTER_DAYS: '3',
    WITHE_RETENTION_DAYS: '90',
    WITHE_AUTH_USER: 'me',
    WITHE_AUTH_PASS: 'pw',
    WITHE_TLS_CERT: '/certs/c.pem',
    WITHE_TLS_KEY: '/certs/k.pem',
    WITHE_BIND: '0.0.0.0',
    WITHE_PORT: '8080',
  });

  assert.equal(config.dbPath, '/tmp/x.db');
  assert.equal(config.syncIntervalSeconds, 60);
  assert.equal(config.stalledAfterDays, 3);
  assert.equal(config.retentionDays, 90);
  assert.deepEqual(config.auth, { user: 'me', pass: 'pw' });
  assert.deepEqual(config.tls, { cert: '/certs/c.pem', key: '/certs/k.pem' });
  assert.equal(config.bind, '0.0.0.0');
  assert.equal(config.port, 8080);
});

test('a config file wins, and the flat variables are ignored with a warning', () => {
  const path = file(`
sources:
  - id: home-ce
    kind: ce
    url: https://renovate.home.lan
    tokenEnv: HOME_CE_TOKEN
`);

  const config = loadConfig({
    WITHE_CONFIG: path,
    WITHE_CE_URL: 'http://ignored',
    WITHE_CE_TOKEN: 'ignored',
    HOME_CE_TOKEN: 'from-the-environment',
  });

  assert.deepEqual(config.sources, [
    { id: 'home-ce', kind: 'ce', url: 'https://renovate.home.lan', token: 'from-the-environment' },
  ]);
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0] ?? '', /WITHE_CE_URL and WITHE_CE_TOKEN are ignored/);
});

test('a literal secret in the file is rejected, not quietly accepted', () => {
  const path = file(`
sources:
  - id: home-ce
    kind: ce
    url: https://renovate.home.lan
    token: a-real-secret
`);

  assert.throws(() => loadConfig({ WITHE_CONFIG: path }), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.field, 'sources[0].token');
    assert.match(error.message, /must not hold a secret.*tokenEnv/s);
    return true;
  });
});

test('tokenEnv naming an unset variable fails at startup, not at first sync', () => {
  const path = file(`
sources:
  - id: home-ce
    kind: ce
    url: https://renovate.home.lan
    tokenEnv: NOT_SET_ANYWHERE
`);

  assert.throws(
    () => loadConfig({ WITHE_CONFIG: path }),
    /sources\[0\]\.tokenEnv: names NOT_SET_ANYWHERE, which is not set/,
  );
});

test('several sources load, and v1.1 kinds are accepted now', () => {
  const path = file(`
sources:
  - id: home-ce
    kind: ce
    url: https://renovate.home.lan
    tokenEnv: A
  - id: cron-logs
    kind: jsonlog
    path: /logs/renovate
`);

  const config = loadConfig({ WITHE_CONFIG: path, A: 'token' });
  assert.deepEqual(
    config.sources.map((s) => [s.id, s.kind]),
    [['home-ce', 'ce'], ['cron-logs', 'jsonlog']],
  );
});

test('a duplicate id is rejected, because it is the join key for every row', () => {
  const path = file(`
sources:
  - id: same
    kind: ce
    url: http://a
    tokenEnv: A
  - id: same
    kind: ce
    url: http://b
    tokenEnv: A
`);

  assert.throws(() => loadConfig({ WITHE_CONFIG: path, A: 't' }), /'same' is used more than once/);
});

test('an invalid file names the field that is wrong', () => {
  const cases: [string, RegExp][] = [
    ['sources: not-a-list', /sources: must be a list/],
    ['sources:\n  - kind: ce', /sources\[0\]\.id: must be a non-empty string/],
    ['sources:\n  - id: a\n    kind: smtp', /sources\[0\]\.kind: 'smtp' is not one of/],
    ['sources:\n  - id: a\n    kind: ce\n    tokenEnv: A', /sources\[0\]\.url: is required/],
    ['sources:\n  - id: a\n    kind: ce\n    url: http://x', /sources\[0\]\.tokenEnv: is required/],
    ['just a string', /must be a mapping with a `sources` list/],
    ['sources:\n  - id: a\n    kind: ce\n    url: http://x\n    tokenEnv: A\n    orgs: nope', /orgs: must be a list of strings/],
  ];

  for (const [body, pattern] of cases) {
    assert.throws(() => loadConfig({ WITHE_CONFIG: file(body), A: 't' }), pattern, body);
  }
});

test('half-configured authentication fails rather than leaving the dashboard open', () => {
  assert.throws(
    () => loadConfig({ WITHE_CONFIG: NO_FILE, WITHE_AUTH_USER: 'me' }),
    /WITHE_AUTH_PASS: is required/,
  );
  assert.throws(
    () => loadConfig({ WITHE_CONFIG: NO_FILE, WITHE_AUTH_PASS: 'pw' }),
    /WITHE_AUTH_USER: is required/,
  );
});

test('half-configured TLS fails too', () => {
  assert.throws(
    () => loadConfig({ WITHE_CONFIG: NO_FILE, WITHE_TLS_CERT: '/c.pem' }),
    /WITHE_TLS_KEY: is required/,
  );
});

test('a flat source missing half its pair is named precisely', () => {
  assert.throws(
    () => loadConfig({ WITHE_CONFIG: NO_FILE, WITHE_CE_URL: 'http://x' }),
    /WITHE_CE_TOKEN: is required/,
  );
  assert.throws(
    () => loadConfig({ WITHE_CONFIG: NO_FILE, WITHE_CE_TOKEN: 'x' }),
    /WITHE_CE_URL: is required/,
  );
});

test('a number that would break a safeguard is rejected by name', () => {
  for (const name of ['WITHE_SYNC_INTERVAL_SECONDS', 'WITHE_STALLED_AFTER_DAYS', 'WITHE_PORT']) {
    assert.throws(
      () => loadConfig({ WITHE_CONFIG: NO_FILE, [name]: '0' }),
      new RegExp(`${name}: must be a positive number`),
    );
    assert.throws(
      () => loadConfig({ WITHE_CONFIG: NO_FILE, [name]: 'soon' }),
      new RegExp(`${name}: must be a positive number`),
    );
  }
});

test('no configuration at all is empty rather than an error', () => {
  // The preflight page explains this state. Refusing to start would leave the
  // operator with a container that dies and no page to read.
  const config = loadConfig({ WITHE_CONFIG: NO_FILE });
  assert.deepEqual(config.sources, []);
});

test('TEMPORARY(org-discovery): organizations load from both shapes', () => {
  const flat = loadConfig({
    WITHE_CONFIG: NO_FILE,
    WITHE_CE_URL: 'http://x',
    WITHE_CE_TOKEN: 't',
    WITHE_CE_ORGS: ' acme , widgets ',
  });
  assert.deepEqual(flat.sources[0]?.orgs, ['acme', 'widgets']);

  const path = file(`
sources:
  - id: a
    kind: ce
    url: http://x
    tokenEnv: A
    orgs: [acme]
`);
  assert.deepEqual(loadConfig({ WITHE_CONFIG: path, A: 't' }).sources[0]?.orgs, ['acme']);
});
