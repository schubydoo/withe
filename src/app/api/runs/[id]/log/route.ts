/**
 * Stream one run's log from the source, through the server.
 *
 * NFR-8 forbids sending the source token to the browser, so the log cannot be
 * fetched client-side. This handler attaches the credential, streams the
 * response body straight through without buffering it, and never lets an
 * upstream URL or credential reach the response.
 */
import { existsSync } from 'node:fs';

import { createAdapter } from '../../../../../adapters/register.ts';
import { loadConfig } from '../../../../../config/load.ts';
import { authGuard } from '../../../../../core/basic-auth.ts';
import type { RenovateRun } from '../../../../../core/model.ts';
import { openDatabase } from '../../../../../db/client.ts';
import { runLocation } from '../../../../../db/queries.ts';
import { logFilename } from './filename.ts';

export const dynamic = 'force-dynamic';

function problem(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const config = loadConfig();
  const url = new URL(request.url);

  // The proxy layer already checked this. It is checked again here because
  // this is the one route that returns real repository content, and the
  // framework's own guidance treats that layer as a last resort rather than an
  // authorization boundary. Before the id is even read: an anonymous caller
  // learns nothing, not even whether a run exists.
  const refusal = await authGuard(request, url.pathname, config.auth);
  if (refusal) return refusal;

  const { id: raw } = await context.params;

  // The id addresses a row, never a path. Anything else is rejected before it
  // can reach a query.
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return problem(400, 'That is not a run id.');

  if (!existsSync(config.dbPath)) return problem(503, 'Withe has not synced yet.');

  const { sqlite, db } = openDatabase(config.dbPath);
  let location;
  try {
    location = runLocation(db, id);
  } finally {
    sqlite.close();
  }
  if (!location) return problem(404, 'No such run.');

  const source = config.sources.find((s) => s.id === location.sourceAdapterId);
  if (!source) {
    // The run was collected by a source that is no longer configured. Saying so
    // is more useful than a generic failure, and names nothing sensitive.
    return problem(409, `The source '${location.sourceAdapterId}' is no longer configured.`);
  }

  // Only the fields fetchLog reads. Building the whole model here would mean
  // inventing values that would then be wrong.
  const run: Pick<RenovateRun, 'repoId' | 'externalJobId'> = {
    repoId: `${location.sourceAdapterId}:${location.repoFullName}`,
    externalJobId: location.externalJobId,
  };

  // `?download` turns the same stream into a saved file. Without it, a browser
  // opening the URL shows the log; with it, the browser saves it under a name
  // that identifies the repository, run, and date without being opened. Either
  // way the body is the whole log as the source served it, not the viewer's
  // filtered subset (B-1). A bare `?download` is on; an explicit `=0`/`=false`
  // is off, so the flag reads the way a hand-edited URL would expect.
  const downloadParam = url.searchParams.get('download');
  const download = downloadParam !== null && downloadParam !== '0' && downloadParam !== 'false';

  try {
    const body = await createAdapter(source).fetchLog(run);
    const headers: Record<string, string> = {
      // NDJSON rendered as text: a browser opening this directly should show
      // it rather than download it.
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    };
    if (download) {
      headers['content-disposition'] = `attachment; filename="${logFilename(location)}"`;
    }
    return new Response(body, { headers });
  } catch (cause) {
    // Deliberately vague about the upstream. The message an adapter throws can
    // carry a URL, and this response goes to a browser.
    const status = /\(404\)/.test(describe(cause)) ? 410 : 502;
    return problem(
      status,
      status === 410
        ? 'That log is no longer retained by the Renovate server. Run history is kept; logs are not.'
        : 'Could not read that log from the Renovate server.',
    );
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
