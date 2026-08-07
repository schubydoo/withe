import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../config/load.ts';
import { dependencyLink, pullRequestUrl, repoUrl } from '../core/links.ts';
import { isHeld } from '../core/renovate-log.ts';
import { openDatabase } from '../db/client.ts';
import {
  forges,
  lastSync,
  lockFileRefreshes,
  pendingUpdates,
  triage,
  type ForgeInfo,
  type LockFileRefreshRow,
  type PendingUpdateRow,
  type TriageRow,
} from '../db/queries.ts';

export const dynamic = 'force-dynamic';

function read() {
  // An unconfigured or never-synced instance is sent to the setup check rather
  // than shown an empty dashboard. An unexplained empty page is the failure
  // that loses a first-time user, and it looks identical to a broken install.
  const config = loadConfig();
  if (config.sources.length === 0) redirect('/preflight');
  if (!existsSync(config.dbPath)) redirect('/preflight');

  // Reads only. No source is called while a page renders, so an unreachable
  // server makes this stale rather than broken.
  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return {
      updates: pendingUpdates(db),
      locks: lockFileRefreshes(db),
      repos: triage(db),
      forge: forges(db),
      sync: lastSync(db),
      intervalSeconds: config.syncIntervalSeconds,
      stalledAfterDays: config.stalledAfterDays,
    };
  } finally {
    sqlite.close();
  }
}

function age(from: Date | null): string {
  if (!from) return 'unknown';
  const minutes = Math.round((Date.now() - from.getTime()) / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

function link(row: { org: string; name: string }): string {
  return `/repos/${encodeURIComponent(row.org)}/${encodeURIComponent(row.name)}`;
}

/** A link, or the same text unlinked when nothing can be addressed. */
function Maybe({ href, children, title }: { href: string | null; children: React.ReactNode; title?: string }) {
  if (!href) return <>{children}</>;
  return (
    <a
      className="underline decoration-neutral-300 hover:decoration-neutral-600"
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

function Group({
  title,
  rows,
  empty,
  forge,
}: {
  title: string;
  rows: PendingUpdateRow[];
  empty: string;
  forge: Map<string, ForgeInfo>;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {title} <span className="font-normal">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">{empty}</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.repoFullName}/${row.dependencyName}/${row.targetVersion}`}
                className="border-t border-neutral-200"
              >
                <td className="py-1 pr-4 text-neutral-500">
                  <Maybe href={repoUrl(info(forge, row).webBaseUrl, row.repoFullName)}>
                    {row.repoFullName}
                  </Maybe>
                </td>
                <td className="py-1 pr-4 font-medium">
                  {row.dependencyName}
                  {row.packageFileCount > 1 && (
                    <span className="ml-1 text-neutral-400">×{row.packageFileCount} files</span>
                  )}
                </td>
                <td className="py-1 pr-4 tabular-nums text-neutral-600">
                  <Maybe
                    href={
                      dependencyLink(row.datasource, row.packageName, row.currentVersion, row.targetVersion)
                        ?.href ?? null
                    }
                    title={
                      dependencyLink(row.datasource, row.packageName, row.currentVersion, row.targetVersion)
                        ?.kind === 'compare'
                        ? 'Compare these two versions upstream'
                        : 'Open the package page'
                    }
                  >
                    {row.currentVersion} → {row.targetVersion}
                  </Maybe>
                </td>
                <td className="py-1 pr-4 text-neutral-500">{row.updateType}</td>
                <td className="py-1 text-neutral-500">
                  {row.prNumber === null ? '' : (
                    <Maybe
                      href={pullRequestUrl(
                        info(forge, row).webBaseUrl,
                        info(forge, row).platform,
                        row.repoFullName,
                        row.prNumber,
                      )}
                    >
                      PR #{row.prNumber}
                    </Maybe>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function info(forge: Map<string, ForgeInfo>, row: { sourceAdapterId: string }): ForgeInfo {
  return forge.get(row.sourceAdapterId) ?? { platform: null, webBaseUrl: null };
}

/**
 * Pending lock-file refreshes, one row per branch.
 *
 * Kept out of the three groups above because a refresh names no dependency and
 * no version pair, and because it is usually the largest group: it would bury
 * every update that a person has to decide about. Listed here rather than only
 * counted, so an operator can see which repositories are waiting.
 */
function Locks({ rows, forge }: { rows: LockFileRefreshRow[]; forge: Map<string, ForgeInfo> }) {
  const repos = new Set(rows.map((r) => r.repoFullName)).size;
  const manifests = rows.reduce((sum, r) => sum + r.packageFileCount, 0);

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Lock file refreshes <span className="font-normal">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">No lock-file refreshes pending.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-neutral-500">
            Across {repos} {repos === 1 ? 'repository' : 'repositories'}, covering {manifests}{' '}
            {manifests === 1 ? 'manifest' : 'manifests'}. Each refreshes every transitive pin on its
            branch, so it names no dependency.
          </p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <th scope="col" className="py-1 pr-4 font-medium">Repository</th>
                <th scope="col" className="py-1 pr-4 font-medium">Branch</th>
                <th scope="col" className="py-1 pr-4 font-medium">Manifests</th>
                <th scope="col" className="py-1 font-medium">Pull request</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.repoFullName}/${row.branchName}`} className="border-t border-neutral-200">
                  <td className="py-1 pr-4 text-neutral-500">
                    <Maybe href={repoUrl(info(forge, row).webBaseUrl, row.repoFullName)}>
                      {row.repoFullName}
                    </Maybe>
                  </td>
                  <td className="py-1 pr-4 font-medium">{row.branchName}</td>
                  <td className="py-1 pr-4 tabular-nums text-neutral-600">
                    {/* Withe stores the count, not the paths. The count opens
                        the run log filtered to this branch, which is where the
                        manifests are named. The filter narrows the log to the
                        lines that mention the branch; it does not isolate one
                        branch's manifests, because Renovate reports every
                        branch in a single `branchesInformation` line. */}
                    {row.lastRunId === null ? (
                      row.packageFileCount
                    ) : (
                      <a
                        className="underline decoration-neutral-300 hover:decoration-neutral-600"
                        href={`/runs/${row.lastRunId}?q=${encodeURIComponent(row.branchName)}`}
                        title="Open the newest run log, filtered to this branch"
                      >
                        {row.packageFileCount}
                      </a>
                    )}
                  </td>
                  <td className="py-1 text-neutral-500">
                    {row.prNumber === null ? '' : (
                      <Maybe
                        href={pullRequestUrl(
                          info(forge, row).webBaseUrl,
                          info(forge, row).platform,
                          row.repoFullName,
                          row.prNumber,
                        )}
                      >
                        PR #{row.prNumber}
                      </Maybe>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Trouble({ failing, stalled }: { failing: TriageRow[]; stalled: TriageRow[] }) {
  if (failing.length === 0 && stalled.length === 0) {
    return (
      <p className="mt-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
        Nothing is broken. Every repository&rsquo;s most recent run succeeded.
      </p>
    );
  }

  // The oldest failure, because that is the one that has been ignored longest.
  const oldest = failing
    .map((r) => r.failingSince)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return (
    <section className="mt-4 rounded border border-red-200 bg-red-50 p-4">
      <h2 className="text-lg font-medium text-red-900">
        {failing.length > 0 && (
          <>
            {failing.length} {failing.length === 1 ? 'repository is' : 'repositories are'} failing
            {oldest && <>, the oldest for {age(oldest)}</>}
          </>
        )}
        {failing.length > 0 && stalled.length > 0 && ' · '}
        {stalled.length > 0 && (
          <>
            {stalled.length} {stalled.length === 1 ? 'is' : 'are'} stalled
          </>
        )}
      </h2>

      <ul className="mt-3 space-y-2 text-sm">
        {[...failing, ...stalled.filter((s) => !failing.includes(s))].map((row) => (
          <li key={row.fullName}>
            <a className="font-medium underline" href={link(row)}>
              {row.fullName}
            </a>
            <span className="ml-2 text-neutral-700">
              {row.lastRunStatus !== null && row.lastRunStatus !== 'success'
                ? `failing for ${age(row.failingSince)}`
                : // A repository with no runs at all is a different problem
                  // from one whose runs stopped, and saying "in unknown"
                  // describes neither.
                  row.lastRunAt === null
                  ? 'no runs recorded at all'
                  : `no successful run in ${age(row.lastRunAt)}`}
            </span>
            {row.lastError && (
              <p className="mt-0.5 max-w-2xl text-xs text-red-800">{row.lastError}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Home() {
  const { updates, locks, repos, forge, sync, intervalSeconds, stalledAfterDays } = read();

  if (repos.length === 0) redirect('/preflight');

  const failing = repos.filter((r) => r.lastRunStatus !== null && r.lastRunStatus !== 'success');
  // A repository can be stalled without any run having failed — nothing ran at
  // all. That is the case F-04 singles out, and a failure list alone misses it.
  const stalled = repos.filter((r) => r.stalled && !failing.includes(r));

  const held = updates.filter((u) =>
    isHeld({ updateType: u.updateType, currentVersion: u.currentVersion }),
  );
  const heldKeys = new Set(held);
  const rest = updates.filter((u) => !heldKeys.has(u));
  const open = rest.filter((u) => u.prNumber !== null);
  const queued = rest.filter((u) => u.prNumber === null);

  // Two missed cycles is late enough to mean something and rare enough not to
  // cry wolf during a slow sync.
  const stale =
    sync.lastSyncAt !== null && Date.now() - sync.lastSyncAt.getTime() > intervalSeconds * 2000;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Withe</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {repos.length} repositories · {updates.length + locks.length} pending updates ·{' '}
        <a className="underline" href="/repos">
          all repositories
        </a>
      </p>

      {(stale || sync.lastSyncAt === null) && (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {sync.lastSyncAt === null
            ? 'Withe has never completed a sync. Everything below is empty rather than wrong.'
            : `Last successful sync ${age(sync.lastSyncAt)} ago, against a ${intervalSeconds}-second interval. Everything below may be out of date.`}{' '}
          <a className="underline" href="/preflight">
            Check the connection
          </a>
          .
        </p>
      )}

      <Trouble failing={failing} stalled={stalled} />

      <Group
        title="Held for your review"
        rows={held}
        forge={forge}
        empty="Nothing is waiting on a decision. Majors and 0.x minors appear here."
      />
      <Group title="Open pull requests" rows={open} forge={forge} empty="No update has an open pull request." />
      <Group title="Queued, no pull request yet" rows={queued} forge={forge} empty="Nothing is queued." />

      <Locks rows={locks} forge={forge} />

      <section className="mt-8 text-sm text-neutral-500">
        <p>A repository counts as stalled after {stalledAfterDays} days with no successful run.</p>
      </section>
    </main>
  );
}
