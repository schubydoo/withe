import type { RunLocation } from '../../../../../db/queries.ts';

/**
 * A download name that reads on its own: `renovate-<org>-<repo>-<date>-job-<id>.log`.
 * Every part is reduced to filename-safe characters, so the header value needs
 * no escaping and the saved file opens on any platform. A run with no instant is
 * named "undated" rather than left without a date.
 */
export function logFilename(
  location: Pick<RunLocation, 'repoFullName' | 'externalJobId' | 'at'>,
): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const repo = safe(location.repoFullName);
  const job = safe(location.externalJobId);
  const date = location.at ? location.at.toISOString().slice(0, 10) : 'undated';
  return `renovate-${repo}-${date}-job-${job}.log`;
}
