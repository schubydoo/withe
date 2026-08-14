/**
 * Is the web server answering? (`HEALTHCHECK` in the Dockerfile.)
 *
 * Any HTTP response counts, including 401. The question this asks is whether
 * the process is serving, and a server that refuses a request without
 * credentials is serving. Task 3.6 replaces this with `/api/health`, which
 * will also say whether the worker is still syncing.
 */
import { request } from 'node:http';

import { loadConfig } from './config/load.ts';

const config = loadConfig();
const host = config.webBind === '0.0.0.0' ? '127.0.0.1' : config.webBind;

const probe = request(
  { host, port: config.webPort, path: '/', method: 'HEAD', timeout: 4000 },
  (response) => {
    // 5xx means the server is up and broken, which the restart policy should
    // hear about; anything else means it is answering.
    process.exit(response.statusCode && response.statusCode >= 500 ? 1 : 0);
  },
);

probe.on('timeout', () => {
  probe.destroy();
  process.exit(1);
});
probe.on('error', () => process.exit(1));
probe.end();
