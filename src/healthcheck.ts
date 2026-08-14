/**
 * Is Withe working? (`HEALTHCHECK` in the Dockerfile.)
 *
 * `/api/health` answers 200 only when a source has synced within three
 * intervals, so this catches the half-dead container a plain HTTP check calls
 * healthy: the web process serving yesterday's data with no worker behind it.
 *
 * It is the one route that answers without credentials, so a healthcheck never
 * needs the operator's password.
 */
import { request } from 'node:http';

import { loadConfig } from './config/load.ts';

const config = loadConfig();
const host = config.webBind === '0.0.0.0' ? '127.0.0.1' : config.webBind;

const probe = request(
  { host, port: config.webPort, path: '/api/health', timeout: 4000 },
  (response) => {
    // 503 is a stale or unstarted sync; anything else that answers is fine.
    // The body is read so the connection closes cleanly rather than being
    // destroyed mid-response every minute.
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);

probe.on('timeout', () => {
  probe.destroy();
  process.exit(1);
});
probe.on('error', () => process.exit(1));
probe.end();
