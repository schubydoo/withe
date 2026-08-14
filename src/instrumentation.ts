/**
 * Runs once per Next.js server process, before the first request.
 *
 * The web process logs through Next's own console, so the redaction filter has
 * to be installed here rather than in a route handler — by the time a handler
 * runs, the server has already written its startup lines, and an error thrown
 * during rendering is printed by the framework rather than by Withe.
 */
import { loadConfig } from './config/load.ts';
import { installRedaction, secretsFrom } from './core/redact.ts';

export function register(): void {
  installRedaction(secretsFrom(loadConfig()));
}
