/**
 * A single sync pass, run from the command line.
 *
 * Sprint 1 has no supervised worker; that is Task 2.1. This exists so the page
 * has rows to read, and so a sync can be run by hand while developing.
 */
import { createAdapter } from '../adapters/registry.ts';
import '../adapters/ce/adapter.ts';
import { openDatabase } from '../db/client.ts';
import { persist } from '../db/persist.ts';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const url = process.env.WITHE_CE_URL;
const token = process.env.WITHE_CE_TOKEN;
const id = process.env.WITHE_SOURCE_ID ?? 'ce';
const file = process.env.WITHE_DB_PATH ?? './withe.db';

if (!url || !token) {
  console.error('Set WITHE_CE_URL and WITHE_CE_TOKEN.');
  process.exit(2);
}

const { sqlite, db } = openDatabase(file);
migrate(db, { migrationsFolder: './drizzle' });

// TEMPORARY(org-discovery). See SourceConfig.orgs and tad.md Section 7.7.2.
const orgs = process.env.WITHE_CE_ORGS?.split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const adapter = createAdapter({ id, kind: 'ce', url, token, orgs });
const startedAt = new Date();

const preflight = await adapter.preflight();
if (!preflight.ok) {
  for (const problem of preflight.problems) {
    console.error(`preflight ${problem.probe}: ${problem.detail}${problem.setting ? ` (${problem.setting})` : ''}`);
  }
  process.exit(1);
}

const result = await adapter.collect();
for (const warning of result.warnings) console.warn(`warning: ${warning}`);

const counts = persist(db, id, 'ce', result, startedAt);
sqlite.close();

console.log(
  `synced ${counts.repos} repositories, ${counts.runs} runs, ${counts.updates} updates into ${file}`,
);
