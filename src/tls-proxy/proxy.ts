/**
 * TLS termination, in its own process (AD-2, `tad.md` Section 7.4).
 *
 * Next.js standalone output emits its own `server.js` and supports no custom
 * server, so HTTPS cannot be added inside the web process without giving up
 * standalone and the image size that depends on it. This process terminates
 * TLS instead and forwards to the web server over loopback, which is private
 * inside a container.
 *
 * Withe does not obtain or renew certificates. The operator's ACME client or
 * reverse proxy does that; this reads two paths and nothing more.
 */
import { readFileSync } from 'node:fs';
import { request as forwardRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';

export class TlsError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'TlsError';
    this.file = file;
  }
}

export interface KeyPair {
  cert: Buffer;
  key: Buffer;
}

/**
 * Read both files, naming whichever one failed.
 *
 * A certificate path that is wrong by one character otherwise produces an
 * `ENOENT` inside a start-up trace, leaving the operator two paths to check.
 */
export function readKeyPair(certPath: string, keyPath: string): KeyPair {
  return { cert: readOne(certPath, 'certificate'), key: readOne(keyPath, 'private key') };
}

function readOne(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    const why =
      code === 'ENOENT'
        ? 'does not exist'
        : code === 'EACCES'
          ? 'cannot be read by this user'
          : `could not be read (${code ?? describe(cause)})`;
    throw new TlsError(path, `the ${what} ${why}`);
  }
}

/**
 * TLS 1.2 is the floor and 1.3 is used whenever the client offers it, with
 * Node's own cipher list. HSTS is not sent — see `relay` below.
 */
export function tlsOptions(pair: KeyPair): { cert: Buffer; key: Buffer; minVersion: 'TLSv1.2' } {
  return { cert: pair.cert, key: pair.key, minVersion: 'TLSv1.2' };
}

/**
 * What the web server is told about the client.
 *
 * The connection it sees comes from loopback, so without these the address in
 * every log line, and in the credential throttle behind Task 3.1, would be
 * this proxy rather than whoever called.
 */
export function forwardedHeaders(
  headers: IncomingMessage['headers'],
  remoteAddress: string | undefined,
): IncomingMessage['headers'] {
  const forwarded = { ...headers };
  const chain = headers['x-forwarded-for'];
  const client = remoteAddress ?? 'unknown';
  forwarded['x-forwarded-for'] = chain ? `${chain}, ${client}` : client;
  forwarded['x-forwarded-proto'] = 'https';
  return forwarded;
}

export interface ProxyOptions {
  pair: KeyPair;
  /** Where the Next.js server listens. Loopback, always. */
  upstreamHost: string;
  upstreamPort: number;
  onError?: (message: string) => void;
}

/**
 * Build the server. Starting it is the caller's job, so a test can listen on
 * an ephemeral port.
 *
 * The certificate and key are checked as a pair here: `createServer` is what
 * rejects a mismatch, and repeating that check by hand would mean
 * reimplementing it.
 */
export function createTlsProxy(options: ProxyOptions): Server {
  try {
    return createServer(tlsOptions(options.pair), (incoming, outgoing) =>
      relay(incoming, outgoing, options),
    );
  } catch (cause) {
    // OpenSSL reports a mismatched pair in a message that names neither file.
    throw new TlsError('the certificate and key', `do not match (${describe(cause)})`);
  }
}

function relay(incoming: IncomingMessage, outgoing: ServerResponse, options: ProxyOptions): void {
  const upstream = forwardRequest(
    {
      host: options.upstreamHost,
      port: options.upstreamPort,
      method: incoming.method,
      path: incoming.url,
      headers: forwardedHeaders(incoming.headers, incoming.socket.remoteAddress),
    },
    (response) => {
      // Copied as they arrive, and nothing is added. No Strict-Transport-
      // Security in particular: a homelab hostname is reused across services,
      // and a stray HSTS pin outlives the deployment that set it.
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );

  upstream.on('error', (cause) => {
    options.onError?.(`tls-proxy: upstream request failed: ${describe(cause)}`);
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    outgoing.end('Withe is not answering behind its TLS proxy.\n');
  });

  incoming.pipe(upstream);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
