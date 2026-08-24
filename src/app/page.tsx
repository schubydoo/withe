import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../config/load.ts';
import { collapseBy, groupByFullName } from '../core/group.ts';
import { dependencyLink, pullRequestUrl, repoUrl } from '../core/links.ts';
import { isHeld } from '../core/renovate-log.ts';
import { openDatabase } from '../db/client.ts';
import {
  forges,
  lockFileRefreshes,
  pendingUpdates,
  schedules,
  triage,
  type ForgeInfo,
  type LockFileRefreshRow,
  type PendingUpdateRow,
  type TriageRow,
} from '../db/queries.ts';
import { foldLock, foldUpdate } from './collapse.ts';
import { soonestNextRun } from './next-run.ts';
import { NextRun } from './next-run.tsx';

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
    const forge = forges(db);
    return {
      // A repository two sources both watch reports each update once per source.
      // Collapse the copies to one row, merging their facts — a forge on one, a
      // pull request on another — so the dashboard counts and links it once
      // (Q-7 — display-time grouping, Task 4.8).
      updates: collapseBy(pendingUpdates(db), updateIdentity, (group) => foldUpdate(group, forge)),
      locks: collapseBy(lockFileRefreshes(db), lockIdentity, (group) => foldLock(group, forge)),
      // The primary is the freshest observer, so the trouble list reads its
      // latest state — a fresher success hides a staler source's failure, which
      // is the true current state on a single-runner install and keeps this page
      // agreeing with /repos. Deliberate; union semantics would report failures
      // a fresher run has already cleared.
      repos: groupByFullName(triage(db)).map((group) => group.primary),
      forge,
      schedule: schedules(db),
      compareUrl: config.compareUrl,
      intervalSeconds: config.syncIntervalSeconds,
      stalledAfterDays: config.stalledAfterDays,
    };
  } finally {
    sqlite.close();
  }
}

// The dependency and its version pair name the update; the source that reported
// it does not. Two sources describing one repository report the same pending
// update, so this key groups the copies for collapseBy to merge (foldUpdate).
const FIELD = '\u0000';
function updateIdentity(u: PendingUpdateRow): string {
  return [u.repoFullName, u.dependencyName, u.currentVersion, u.targetVersion, u.updateType].join(FIELD);
}
function lockIdentity(l: LockFileRefreshRow): string {
  return [l.repoFullName, l.branchName].join(FIELD);
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
      className="underline decoration-neutral-300 dark:decoration-neutral-700 hover:decoration-neutral-600"
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
  compareUrl,
  held = false,
}: {
  title: string;
  rows: PendingUpdateRow[];
  empty: string;
  forge: Map<string, ForgeInfo>;
  compareUrl: string | null;
  // The held group mixes rows that have a pull request with rows that do not,
  // so it marks each row's state in the last cell and prints a note that names
  // the review. The version cell already links the upstream change, so the note
  // points there rather than linking it a second time. The other groups are
  // already split by pull-request state in their title, so they leave the flag off.
  held?: boolean;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title} <span className="font-normal">({rows.length})</span>
      </h2>
      {held && rows.length > 0 && (
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          These updates need a person to decide; Withe does not merge them. To review one, follow its
          version link to the upstream change, then act on your forge. A row with no pull request is
          usually not stuck &mdash; Renovate opens one itself once its rate limit, schedule window, or
          release-age hold clears, unless your Renovate config holds majors for approval.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{empty}</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {rows.map((row) => {
              const link = dependencyLink(
                row.datasource,
                row.packageName,
                row.currentVersion,
                row.targetVersion,
                compareUrl,
              );
              return (
                <tr
                  key={`${row.repoFullName}/${row.dependencyName}/${row.targetVersion}`}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-1 pr-4 text-neutral-500 dark:text-neutral-400">
                    <Maybe href={repoUrl(info(forge, row).webBaseUrl, row.repoFullName)}>
                      {row.repoFullName}
                    </Maybe>
                  </td>
                  <td className="py-1 pr-4 font-medium">
                    {row.dependencyName}
                    {row.packageFileCount > 1 && (
                      <span className="ml-1 text-neutral-500 dark:text-neutral-400">×{row.packageFileCount} files</span>
                    )}
                  </td>
                  <td className="py-1 pr-4 tabular-nums text-neutral-600 dark:text-neutral-300">
                    <Maybe
                      href={link?.href ?? null}
                      title={
                        link?.kind === 'compare'
                          ? 'Compare these two versions upstream'
                          : 'Open the package page'
                      }
                    >
                      {row.currentVersion} → {row.targetVersion}
                    </Maybe>
                  </td>
                  <td className="py-1 pr-4 text-neutral-500 dark:text-neutral-400">{row.updateType}</td>
                  <td className="py-1 text-neutral-500 dark:text-neutral-400">
                    {row.prNumber !== null ? (
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
                    ) : held ? (
                      // No pull request yet. Mark the state so a held major does
                      // not read as a PR that never arrived; the review link lives
                      // in the version cell, which the section note points to.
                      'No PR yet'
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              );
            })}
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
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Lock file refreshes <span className="font-normal">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">No lock-file refreshes pending.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Across {repos} {repos === 1 ? 'repository' : 'repositories'}, covering {manifests}{' '}
            {manifests === 1 ? 'manifest' : 'manifests'}. Each refreshes every transitive pin on its
            branch, so it names no dependency.
          </p>
          {/* Fixed layout with set column widths: a long branch slug or a
              dozen manifest paths wraps inside its own column instead of
              stretching the table and squeezing the others. */}
          <table className="mt-2 w-full table-fixed text-sm">
            {/* Manifests is the residual (widthless) column, so it is the
                widest — it carries a workspace's many paths. Every other
                column is a share of the width, so the proportions hold as the
                window narrows rather than starving the manifest cell. */}
            <colgroup>
              <col className="w-1/5" />
              <col className="w-1/4" />
              <col />
              <col className="w-1/12" />
            </colgroup>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                <th scope="col" className="py-1 pr-4 font-medium">Repository</th>
                <th scope="col" className="py-1 pr-4 font-medium">Branch</th>
                <th scope="col" className="py-1 pr-4 font-medium">Manifests</th>
                <th scope="col" className="py-1 font-medium">Pull request</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.repoFullName}/${row.branchName}`} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="py-1 pr-4 align-top break-words text-neutral-500 dark:text-neutral-400">
                    <Maybe href={repoUrl(info(forge, row).webBaseUrl, row.repoFullName)}>
                      {row.repoFullName}
                    </Maybe>
                  </td>
                  <td className="py-1 pr-4 align-top break-words font-medium">{row.branchName}</td>
                  <td className="py-1 pr-4 align-top break-words text-neutral-600 dark:text-neutral-300">
                    <div className="flex items-baseline gap-2">
                      <span className="tabular-nums">{row.packageFileCount}</span>
                      {/* An unnamed branch is already named for its one manifest,
                          so repeating the path says nothing new. */}
                      {row.packageFiles.length > 0 &&
                        !(row.packageFiles.length === 1 && row.packageFiles[0] === row.branchName) && (
                          <ManifestPaths files={row.packageFiles} />
                        )}
                    </div>
                  </td>
                  <td className="py-1 align-top text-neutral-500 dark:text-neutral-400">
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

/**
 * The manifest paths a refresh touches, one per line. A Cargo workspace can
 * carry a dozen; the cell names the first three and hides the rest behind an
 * expander that stays reachable by keyboard, which a title tooltip would not
 * be. One path per line reads better than a comma-joined run that wraps
 * mid-path.
 */
function ManifestPaths({ files }: { files: string[] }) {
  const head = files.slice(0, 3);
  const rest = files.slice(3);
  return (
    <div className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
      {head.map((file) => (
        <div key={file} className="break-words">
          {file}
        </div>
      ))}
      {rest.length > 0 && (
        <details className="break-words">
          <summary className="cursor-pointer">+{rest.length} more</summary>
          {rest.map((file) => (
            <div key={file} className="break-words">
              {file}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function Trouble({ failing, stalled }: { failing: TriageRow[]; stalled: TriageRow[] }) {
  if (failing.length === 0 && stalled.length === 0) {
    return (
      <p className="mt-4 rounded border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950 px-3 py-2 text-sm text-green-900 dark:text-green-200">
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
    <section className="mt-4 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4">
      <h2 className="text-lg font-medium text-red-900 dark:text-red-200">
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
            <span className="ml-2 text-neutral-700 dark:text-neutral-300">
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
              <p className="mt-0.5 max-w-2xl text-xs text-red-800 dark:text-red-300">{row.lastError}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Home() {
  const { updates, locks, repos, forge, schedule, compareUrl, intervalSeconds, stalledAfterDays } = read();
  const graceMs = intervalSeconds * 1000;
  const nextRun = soonestNextRun(schedule, Date.now(), graceMs);

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

  // Staleness is shown by the banner in the layout, on every page and from the
  // one threshold in core/health.ts, rather than computed once here at render.
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Withe</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {repos.length} repositories · {updates.length + locks.length} pending updates ·{' '}
        <a className="underline" href="/repos">
          all repositories
        </a>{' '}
        ·{' '}
        <a className="underline" href="/health">
          Renovate health
        </a>
        {nextRun !== null && (
          <>
            {' '}
            · <NextRun atMs={nextRun.getTime()} graceMs={graceMs} />
          </>
        )}
      </p>

      <Trouble failing={failing} stalled={stalled} />

      <Group
        title="Major & 0.x updates"
        rows={held}
        held
        forge={forge}
        compareUrl={compareUrl}
        empty="Nothing here. Major updates and 0.x minors — the ones most likely to need a person — appear in this section."
      />
      <Group
        title="Open pull requests"
        rows={open}
        forge={forge}
        compareUrl={compareUrl}
        empty="No update has an open pull request."
      />
      <Group
        title="Queued, no pull request yet"
        rows={queued}
        forge={forge}
        compareUrl={compareUrl}
        empty="Nothing is queued."
      />

      <Locks rows={locks} forge={forge} />

      <section className="mt-8 text-sm text-neutral-500 dark:text-neutral-400">
        <p>A repository counts as stalled after {stalledAfterDays} days with no successful run.</p>
      </section>
    </main>
  );
}
