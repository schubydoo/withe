/**
 * Take your data and go (F-15, `tad.md` Section 5.6).
 *
 * This is the escape hatch. `prd.md` R-7 names it as the only concrete
 * mitigation for abandonment: a dashboard whose data cannot leave is a trap,
 * and a competitor stranded its users for exactly this reason. So the endpoint
 * is deliberately dumb — every table, no pagination, no filtering — and reads
 * the database directly, which means it keeps working when the sync worker is
 * dead. That is precisely when someone reaches for it.
 *
 *   GET /api/export                 every table as one JSON document
 *   GET /api/export?format=sqlite   a consistent copy, safe to take while syncing
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../../../config/load.ts';
import { authGuard } from '../../../core/basic-auth.ts';
import { openDatabase } from '../../../db/client.ts';

export const dynamic = 'force-dynamic';

function problem(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(request: Request): Promise<Response> {
  const config = loadConfig();

  // The export is the whole database in one request, so it repeats the
  // credential check inside the handler rather than trusting the proxy layer,
  // for the same reason the log route does.
  const refusal = await authGuard(request, new URL(request.url).pathname, config.auth);
  if (refusal) return refusal;

  if (!existsSync(config.dbPath)) return problem(503, 'Withe has not created its database yet.');

  const format = new URL(request.url).searchParams.get('format');

  // A reader connection: it must not run a write-locking pragma while the
  // worker holds the write lock (risk TR-1). VACUUM INTO reads a snapshot and
  // writes a new file, so it is safe against a live writer under WAL.
  const { sqlite } = openDatabase(config.dbPath);
  try {
    if (format === 'sqlite') {
      const dir = mkdtempSync(join(tmpdir(), 'withe-export-'));
      const out = join(dir, 'withe.db');
      try {
        // The path is server-generated, so it cannot carry an injection. VACUUM
        // INTO takes a filename literal, not a bound parameter.
        sqlite.exec(`VACUUM INTO '${out}'`);
        const body = readFileSync(out);
        return new Response(body, {
          headers: {
            'content-type': 'application/vnd.sqlite3',
            'content-disposition': 'attachment; filename="withe-export.db"',
            'cache-control': 'no-store',
          },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // Every table SQLite holds, discovered rather than hard-coded so a future
    // migration is exported without touching this route. The rows are dumped as
    // stored — integer timestamps and all — because a faithful copy is the
    // point, not a rendered view.
    const tables = (
      sqlite
        .prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
        .all() as { name: string }[]
    ).map((r) => r.name);

    const data: Record<string, unknown[]> = {};
    for (const table of tables) {
      data[table] = sqlite.prepare(`select * from "${table}"`).all();
    }

    return new Response(
      JSON.stringify({ withe: 'export', exportedAt: new Date().toISOString(), tables: data }, null, 2),
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="withe-export.json"',
          'cache-control': 'no-store',
        },
      },
    );
  } finally {
    sqlite.close();
  }
}
