/**
 * Decide whether a pull request is one Renovate opened, without asking the
 * operator to edit `renovate.json`.
 *
 * This is assumption AM-2. `renovate-pr-visualization` identifies Renovate pull
 * requests by a label the operator adds, which Withe's non-invasive claim
 * forbids. So identification works from the head branch and the author alone.
 *
 * The rule is a guard, not a discovery step. The enrichment only asks about
 * pull-request numbers the Renovate job log already attached to an update, so
 * the log has already vouched for them. This confirms that before Withe treats
 * a merge or a close as Renovate's, so a repository whose numbering Withe
 * misread cannot flip an unrelated pull request's state.
 *
 * Kept pure and in its own module so it is unit-tested, like
 * `src/app/staleness.ts`.
 */

/** The fields of a pull request this rule reads. Nothing else is needed. */
export interface RenovatePrSubject {
  /** The head branch name, for example `renovate/next-16.x`. */
  headRef: string | null;
  /** The pull request author's login, or null when the forge omits it. */
  authorLogin: string | null;
}

export interface RenovatePrRule {
  /**
   * The branch prefix Renovate writes. Default `renovate/`. An operator who set
   * `branchPrefix` in their Renovate config sets it here too.
   */
  branchPrefix: string;
  /**
   * The logins that count as Renovate. The bot account varies: `renovate[bot]`
   * for the GitHub App, `renovate` for some self-hosted setups, an
   * installation-specific slug, or a human login for a personal access token.
   * The operator adds theirs; the two common ones are the default.
   */
  authorLogins: string[];
}

/** The bot logins Withe assumes without configuration. */
export const DEFAULT_RENOVATE_AUTHORS: readonly string[] = ['renovate[bot]', 'renovate'];

/** The branch prefix Renovate uses unless the operator changed it. */
export const DEFAULT_RENOVATE_BRANCH_PREFIX = 'renovate/';

/**
 * True when the head branch starts with the configured prefix and the author is
 * in the allowlist. Both must hold: a branch prefix alone would match a human
 * branch named the same way, and an author alone would match a bot that also
 * opens non-Renovate pull requests.
 *
 * The comparison is case-insensitive on the author, because forges do not treat
 * a login's case as significant, and exact on the prefix, because a branch name
 * is case-sensitive.
 */
export function isRenovatePr(subject: RenovatePrSubject, rule: RenovatePrRule): boolean {
  const { headRef, authorLogin } = subject;
  if (!headRef || !authorLogin) return false;
  if (!headRef.startsWith(rule.branchPrefix)) return false;
  const login = authorLogin.toLowerCase();
  return rule.authorLogins.some((allowed) => allowed.toLowerCase() === login);
}
