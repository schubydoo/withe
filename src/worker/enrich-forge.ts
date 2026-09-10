/**
 * Refresh pull-request state from the forge, so a merged pull request leaves the
 * dashboard within one sync instead of waiting for Renovate's next run.
 *
 * This runs between an adapter's collect and the persist. The adapter reads the
 * Renovate job log, which is a snapshot from the newest completed run; this
 * re-checks the pull-request numbers that log attached and marks the ones that
 * have since merged or closed. The persist then writes a snapshot that no longer
 * lists them as open (Task 5.1, Task 5.4).
 *
 * It lives in the worker, not in an adapter: a forge produces no repositories or
 * runs, so it is not a source. It composes the GitHub client with the model that
 * an adapter already returned.
 */
import { mapWithLimit } from '../adapters/ce/limit.ts';
import { ForgeError, type GithubForge } from '../adapters/forge/github.ts';
import { isRenovatePr, type RenovatePrRule } from '../adapters/forge/renovate-pr.ts';
import type { CollectResult } from '../adapters/types.ts';

/**
 * How many pull requests to read at once. GitHub allows far more, but a modest
 * ceiling keeps one fleet from spending its whole rate limit in a burst.
 */
const CONCURRENCY = 6;

/**
 * Set the live state on every open update that carries a pull-request number,
 * in place. Returns the warnings to fold into the cycle's degradation channel.
 * It never throws: a forge that loses one pull request degrades to the log's own
 * state rather than failing the sync.
 */
export async function enrichForgeState(
  result: CollectResult,
  forge: GithubForge,
  rule: RenovatePrRule,
): Promise<string[]> {
  const warnings: string[] = [];
  const repoById = new Map(result.repos.map((repo) => [repo.id, repo]));
  const candidates = result.updates.filter(
    (u) => u.state === 'pr-open' && u.pullRequestNumber !== null,
  );

  // Once GitHub reports the limit is spent, stop rather than pile up failures.
  // The states left unrefreshed keep the log's value, which is stale but not
  // wrong, and the next cycle tries again.
  let rateLimited = false;

  await mapWithLimit(candidates, CONCURRENCY, async (u) => {
    if (rateLimited) return;
    const repo = repoById.get(u.repoId);
    const prNumber = u.pullRequestNumber;
    if (!repo || prNumber === null) return;

    try {
      const snapshot = await forge.pullRequest(repo.org, repo.name, prNumber);
      // A gone pull request keeps the log's state; the snapshot delete-insert
      // drops it when Renovate next stops listing the branch.
      if (!snapshot) return;
      // The log already vouched for this number, so this only guards against a
      // number Withe misread pointing at an unrelated pull request.
      if (!isRenovatePr(snapshot, rule)) return;
      if (snapshot.state === 'open') return;

      u.state = snapshot.state === 'merged' ? 'pr-merged' : 'pr-closed';
      u.closedAt = snapshot.closedAt;
      u.closeType = snapshot.closeType;
    } catch (cause) {
      if (cause instanceof ForgeError && (cause.status === 403 || cause.status === 429)) {
        if (!rateLimited) {
          rateLimited = true;
          warnings.push(
            'GitHub rate limit reached; some pull-request states were not refreshed this cycle.',
          );
        }
        return;
      }
      warnings.push(
        `could not read ${repo.fullName}#${prNumber} from GitHub: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  });

  return warnings;
}
