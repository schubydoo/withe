import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createTlsProxy, forwardedHeaders, readKeyPair, tlsOptions, TlsError } from './proxy.ts';

const dir = mkdtempSync(join(tmpdir(), 'withe-tls-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A throwaway self-signed pair. Generated rather than committed: a private key
 * in the repository is a private key in the repository, whatever it is for.
 */
function selfSigned(name: string): { cert: string; key: string } {
  const cert = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=withe.test',
    // A subject alternative name, so the tests can verify the certificate they
    // were given rather than turning verification off.
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:withe.test',
    '-keyout', key, '-out', cert,
  ], { stdio: 'pipe' });
  return { cert, key };
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTPS request, trusting only the certificate this test generated. */
function get(port: number, path: string, ca: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, ca, headers: { 'x-test': 'yes' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('a missing or unreadable file is named, not buried', () => {
  const pair = selfSigned('named');

  assert.throws(
    () => readKeyPair(join(dir, 'absent.crt'), pair.key),
    (error: unknown) => {
      assert.ok(error instanceof TlsError);
      assert.match(error.message, /absent\.crt/);
      assert.match(error.message, /certificate does not exist/);
      return true;
    },
  );

  assert.throws(
    () => readKeyPair(pair.cert, join(dir, 'absent.key')),
    (error: unknown) => {
      assert.ok(error instanceof TlsError);
      assert.match(error.message, /absent\.key/);
      assert.match(error.message, /private key does not exist/);
      return true;
    },
  );
});

test('a mismatched pair is refused rather than served', () => {
  const first = selfSigned('first');
  const second = selfSigned('second');

  assert.throws(
    () =>
      createTlsProxy({
        pair: readKeyPair(first.cert, second.key),
        upstreamHost: '127.0.0.1',
        upstreamPort: 1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof TlsError);
      assert.match(error.message, /do not match/);
      return true;
    },
  );
});

test('TLS 1.2 is the floor', () => {
  const paths = selfSigned('floor');
  assert.equal(tlsOptions(readKeyPair(paths.cert, paths.key)).minVersion, 'TLSv1.2');
});

test('the client address is forwarded rather than replaced by the proxy', () => {
  assert.equal(forwardedHeaders({}, '203.0.113.7')['x-forwarded-for'], '203.0.113.7');
  // An existing chain is appended to, not overwritten.
  assert.equal(
    forwardedHeaders({ 'x-forwarded-for': '198.51.100.2' }, '203.0.113.7')['x-forwarded-for'],
    '198.51.100.2, 203.0.113.7',
  );
  assert.equal(forwardedHeaders({}, undefined)['x-forwarded-for'], 'unknown');
  assert.equal(forwardedHeaders({}, '203.0.113.7')['x-forwarded-proto'], 'https');
});

test('a request survives the round trip, and no HSTS header is added', async () => {
  const paths = selfSigned('round-trip');
  const seen: { url?: string; forwardedFor?: string; proto?: string } = {};

  const upstream = createHttpServer((incoming, outgoing) => {
    seen.url = incoming.url;
    seen.forwardedFor = incoming.headers['x-forwarded-for'] as string;
    seen.proto = incoming.headers['x-forwarded-proto'] as string;
    outgoing.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'web' });
    outgoing.end('the dashboard');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const proxy = createTlsProxy({
    pair: readKeyPair(paths.cert, paths.key),
    upstreamHost: '127.0.0.1',
    upstreamPort,
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as { port: number }).port;

  try {
    const response = await get(proxyPort, '/repos?page=2', readFileSync(paths.cert));

    assert.equal(response.status, 200);
    assert.equal(response.body, 'the dashboard');
    assert.equal(response.headers['x-from'], 'web');
    // A homelab hostname is reused across services and an HSTS pin outlives
    // the deployment that set it.
    assert.equal(response.headers['strict-transport-security'], undefined);
    assert.equal(seen.url, '/repos?page=2');
    assert.equal(seen.proto, 'https');
    assert.equal(seen.forwardedFor, '127.0.0.1');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an upstream that is not listening produces 502 rather than a hang', async () => {
  const paths = selfSigned('no-upstream');
  const proxy = createTlsProxy({
    pair: readKeyPair(paths.cert, paths.key),
    upstreamHost: '127.0.0.1',
    // Nothing listens here: the web server is down while the proxy is up.
    upstreamPort: 1,
    onError: () => {},
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;

  try {
    const response = await get(port, '/', readFileSync(paths.cert));
    assert.equal(response.status, 502);
    assert.match(response.body, /not answering/);
  } finally {
    proxy.close();
  }
});
