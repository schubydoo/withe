/**
 * A thin wrapper over the generated Renovate CE types.
 *
 * Everything here is a read. The CE specification contains four write
 * operations — `/system/v1/sync`, `/system/v1/jobs/purge`, `/system/v1/jobs/add`
 * and `/api/v1/repos/{orgRepo}/-/jobs/run` — and Withe reaches none of them
 * (NFR-11). Task 2.11 adds the lint rule that enforces it.
 */
import createClient, { type Middleware } from 'openapi-fetch';

import type { paths } from './generated/ce.d.ts';

export interface CeClientConfig {
  /** Base URL of the CE server, for example `http://127.0.0.1:7623`. */
  baseUrl: string;
  /**
   * Value of the server's `MEND_RNV_API_SERVER_SECRET`, read from
   * configuration. Never write a token into this file.
   */
  token: string;
}

export type CeClient = ReturnType<typeof createCeClient>;

export function createCeClient({ baseUrl, token }: CeClientConfig) {
  if (!token) {
    throw new Error('A CE API token is required. Set WITHE_CE_TOKEN.');
  }

  const auth: Middleware = {
    onRequest({ request }) {
      request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
  };

  const client = createClient<paths>({ baseUrl: stripTrailingSlash(baseUrl) });
  client.use(auth);
  return client;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Return the `next` target from an RFC 8288 `Link` header, or null.
 *
 * The value is treated as an opaque URL. CE also sends the same cursor in an
 * `X-Next-Cursor` header, and Withe never reads it: a cursor is the server's
 * private encoding and interpreting one is how a client breaks on an upgrade.
 */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;

  for (const field of splitLinkFields(header)) {
    const target = field.match(/^\s*<([^>]*)>/)?.[1];
    if (!target) continue;
    // `rel` may appear in any position, quoted or bare, and a relation type may
    // be one of several space-separated values.
    const rel = field.match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i);
    const value = rel?.[1] ?? rel?.[2];
    if (value && value.split(/\s+/).includes('next')) return target;
  }
  return null;
}

/** Split a Link header on the commas that separate fields, not those inside <>. */
function splitLinkFields(header: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < header.length; i += 1) {
    const c = header[i];
    if (c === '<') depth += 1;
    else if (c === '>') depth -= 1;
    else if (c === ',' && depth === 0) {
      fields.push(header.slice(start, i));
      start = i + 1;
    }
  }
  fields.push(header.slice(start));
  return fields;
}

/**
 * Read every page of a collection endpoint, following `Link: rel="next"`.
 *
 * Task 1.6 consumes this rather than reimplementing pagination. `maxPages` is a
 * runaway guard, not a limit anyone should hit: CE retains roughly 190 jobs per
 * repository at 20 to a page.
 */
export async function* paginate<T>(
  { baseUrl, token }: CeClientConfig,
  path: string,
  maxPages = 200,
): AsyncGenerator<T[], void, undefined> {
  let next: string | null = path;

  for (let page = 0; next !== null && page < maxPages; page += 1) {
    const response: Response = await fetch(new URL(next, stripTrailingSlash(baseUrl) + '/'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`CE responded ${response.status} for ${next}`);
    }
    yield (await response.json()) as T[];
    next = parseNextLink(response.headers.get('link'));
  }
}
