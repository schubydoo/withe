/**
 * Read pull-request state from GitHub, so a merged pull request leaves the
 * dashboard within one sync instead of waiting for Renovate's next run.
 *
 * Task 5.1. Withe reads what the Renovate job log last observed, and the log is
 * a snapshot from the newest completed run. A pull request merged after that
 * run stays on screen until Renovate runs again, which measured up to about 62
 * minutes on the author's fleet. This client re-checks the pull-request numbers
 * the log already attached and reports their live state.
 *
 * Everything here is a read. There is no client library: the surface is a
 * handful of GET requests, so bare `fetch` costs no dependency and no generated
 * type. The house style is `openapi-fetch` for the CE server, whose whole
 * specification Withe consumes; GitHub's is far larger than the three fields
 * this needs, so a generated client would be the heavier choice, not the
 * lighter one.
 */
export type PullRequestState = 'open' | 'merged' | 'closed';

/** The combined commit status, flattened to what a dashboard shows. */
export type CiStatus = 'success' | 'failure' | 'pending' | 'none';

/** What one pull-request read produced. */
export interface PullRequestSnapshot {
  state: PullRequestState;
  /** When it merged or closed. Null while it is open. */
  closedAt: Date | null;
  /** Why it stopped being open. Null while it is open. */
  closeType: 'merge' | 'close' | null;
  /** The head branch, so `isRenovatePr` can confirm it. */
  headRef: string | null;
  /** The author login, so `isRenovatePr` can confirm it. */
  authorLogin: string | null;
}

/** How much of the rate limit is left, from the last response GitHub sent. */
export interface RateLimitHeadroom {
  remaining: number;
  limit: number;
  /** When the window resets. Null when GitHub did not say. */
  resetAt: Date | null;
  /** remaining / limit, or 1 when the limit is unknown. */
  fraction: number;
}

export interface GithubForgeConfig {
  token: string;
  /**
   * The API base. Default `https://api.github.com`. A GitHub Enterprise Server
   * install answers at `https://<host>/api/v3`.
   */
  apiBaseUrl?: string;
}

export interface GithubForge {
  /**
   * The live state of one pull request, or null when GitHub answers 404. A 404
   * means the number names nothing Withe can read, which is not an error the
   * operator must fix.
   */
  pullRequest(owner: string, repo: string, number: number): Promise<PullRequestSnapshot | null>;
  /** The combined CI status of a commit or branch reference (AM-5, GitHub only). */
  commitStatus(owner: string, repo: string, ref: string): Promise<CiStatus>;
  /** The rate-limit headroom from the last response, or null before the first. */
  headroom(): RateLimitHeadroom | null;
}

const DEFAULT_API_BASE = 'https://api.github.com';

/** A shape carrying only the pull-request fields Withe reads. */
interface RawPull {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  head?: { ref?: string | null } | null;
  user?: { login?: string | null } | null;
}

interface RawStatus {
  state?: string;
  total_count?: number;
}

/**
 * An error the caller turns into a warning rather than a crash. A forge that
 * loses one pull request must degrade to the log's own state, not take the sync
 * down.
 */
export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
  }
}

export function createGithubForge(config: GithubForgeConfig): GithubForge {
  if (!config.token) {
    throw new Error('A GitHub token is required. Set WITHE_GITHUB_TOKEN.');
  }
  const base = stripTrailingSlash(config.apiBaseUrl ?? DEFAULT_API_BASE);
  let lastHeadroom: RateLimitHeadroom | null = null;

  async function get(path: string): Promise<Response> {
    const response = await fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'manual',
    });
    lastHeadroom = readHeadroom(response.headers) ?? lastHeadroom;
    return response;
  }

  return {
    async pullRequest(owner, repo, number) {
      const response = await get(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new ForgeError(response.status, `GitHub responded ${response.status} for pull ${owner}/${repo}#${number}`);
      }
      return toSnapshot((await response.json()) as RawPull);
    },

    async commitStatus(owner, repo, ref) {
      const response = await get(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status`);
      if (response.status === 404) return 'none';
      if (!response.ok) {
        throw new ForgeError(response.status, `GitHub responded ${response.status} for status ${owner}/${repo}@${ref}`);
      }
      return toCiStatus((await response.json()) as RawStatus);
    },

    headroom() {
      return lastHeadroom;
    },
  };
}

function toSnapshot(pull: RawPull): PullRequestSnapshot {
  const headRef = pull.head?.ref ?? null;
  const authorLogin = pull.user?.login ?? null;
  if (pull.merged || pull.merged_at) {
    return { state: 'merged', closeType: 'merge', closedAt: parseDate(pull.merged_at), headRef, authorLogin };
  }
  if (pull.state === 'closed') {
    return { state: 'closed', closeType: 'close', closedAt: parseDate(pull.closed_at), headRef, authorLogin };
  }
  return { state: 'open', closeType: null, closedAt: null, headRef, authorLogin };
}

function toCiStatus(status: RawStatus): CiStatus {
  // The combined status reports `pending` with no contexts when nothing has
  // reported, which reads as "waiting" when the truth is "nothing ran".
  if (!status.total_count || status.total_count === 0) return 'none';
  switch (status.state) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    default:
      return 'pending';
  }
}

function readHeadroom(headers: Headers): RateLimitHeadroom | null {
  const limit = Number(headers.get('x-ratelimit-limit'));
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
  const reset = Number(headers.get('x-ratelimit-reset'));
  return {
    limit,
    remaining,
    resetAt: Number.isFinite(reset) ? new Date(reset * 1000) : null,
    fraction: remaining / limit,
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
