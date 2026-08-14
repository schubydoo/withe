/**
 * The `tls-proxy` child. Reads two files, listens, forwards.
 *
 * The supervisor starts this only when both certificate paths are set. Run
 * directly it says the same thing rather than starting an HTTPS server with
 * nothing to serve.
 */
import { loadConfig } from '../config/load.ts';
import { installRedaction, secretsFrom } from '../core/redact.ts';
import { createTlsProxy, readKeyPair, TlsError } from './proxy.ts';

const config = loadConfig();

// NFR-12. A TLS error can quote a path, and an upstream error a URL.
installRedaction(secretsFrom(config));

if (!config.tls) {
  console.error(
    'tls-proxy: WITHE_TLS_CERT and WITHE_TLS_KEY must both be set. ' +
      'Withe serves plain HTTP when they are not.',
  );
  process.exit(2);
}

let server;
try {
  const pair = readKeyPair(config.tls.cert, config.tls.key);
  server = createTlsProxy({
    pair,
    upstreamHost: config.webBind,
    upstreamPort: config.webPort,
    onError: (message) => console.error(message),
  });
} catch (cause) {
  if (cause instanceof TlsError) {
    // Exit 2, not 1: a restart cannot fix a path or a mismatched pair, and the
    // message names the file to correct.
    console.error(`tls-proxy: ${cause.message}`);
    process.exit(2);
  }
  throw cause;
}

server.on('error', (cause: Error) => {
  console.error(`tls-proxy: ${cause.message}`);
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  console.log(
    `tls-proxy: listening on https://${config.bind}:${config.port}, ` +
      `forwarding to ${config.webBind}:${config.webPort}`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
