/**
 * What is reachable, and which setting explains anything that is not.
 *
 * Metric M-5 asks that at least 90% of empty dashboards name the exact missing
 * variable, so the mapping below is data rather than prose, and the result is
 * machine-readable enough for the UI to build a Compose block from it.
 *
 * The mapping was taken from `docs/api.md` and the `tags` on each operation in
 * `openapi-community.yaml`, then checked against a live server. It corrects
 * `tad.md` Section 4.4 in two places, noted on the families below.
 */
import type { PreflightProblem, PreflightRemedy } from '../types.ts';

export type Family = 'system' | 'inventory' | 'jobs' | 'metrics';

interface FamilySpec {
  /** What the operator sees named in the message. */
  label: string;
  /** Server settings that must be set for this family to answer. */
  server: string[];
  /** Settings on the Renovate worker, which is a different container. */
  worker?: string[];
  /** Whether Withe is useless without it. */
  fatal: boolean;
  /** What the operator loses if it stays off. */
  cost: string;
}

export const FAMILIES: Record<Family, FamilySpec> = {
  system: {
    label: 'system status',
    server: ['MEND_RNV_API_ENABLED', 'MEND_RNV_API_ENABLE_SYSTEM'],
    fatal: false,
    cost: 'Queue depth and scheduler health are unavailable. Everything else works.',
  },
  inventory: {
    // tad.md 4.4 said this family needs only MEND_RNV_API_ENABLED. The
    // specification tags getOrgs and getOrgRepos `Reporting`, and docs/api.md
    // says the Reporting APIs need MEND_RNV_API_ENABLE_REPORTING as well. An
    // operator following the old table would enable the wrong variable and
    // still see nothing.
    label: 'organizations and repositories',
    server: ['MEND_RNV_API_ENABLED', 'MEND_RNV_API_ENABLE_REPORTING'],
    worker: ['RENOVATE_REPOSITORY_CACHE'],
    fatal: true,
    cost: 'Withe cannot list anything without this.',
  },
  jobs: {
    // tad.md 4.4 said MEND_RNV_API_ENABLE_JOBS. The specification tags
    // getRepoJobs `API`, not `Jobs`, so MEND_RNV_API_ENABLED is what gates it.
    // MEND_RNV_API_ENABLE_JOBS governs the system-level job queue, which Withe
    // never calls.
    label: 'run history',
    server: ['MEND_RNV_API_ENABLED'],
    fatal: false,
    cost: 'Repositories still appear, with no run history and no pending updates.',
  },
  metrics: {
    label: 'Prometheus metrics',
    server: ['MEND_RNV_API_ENABLE_PROMETHEUS_METRICS'],
    fatal: false,
    cost: 'Nothing in Withe uses these today. Safe to leave off.',
  },
};

/** The value each setting wants, so the UI can render a Compose block. */
const VALUES: Record<string, string> = {
  RENOVATE_REPOSITORY_CACHE: 'enabled',
};

function remediesFor(family: Family): PreflightRemedy[] {
  const spec = FAMILIES[family];
  const server = spec.server.map((variable) => ({
    variable,
    value: VALUES[variable] ?? 'true',
    target: 'server' as const,
  }));
  const worker = (spec.worker ?? []).map((variable) => ({
    variable,
    value: VALUES[variable] ?? 'true',
    target: 'worker' as const,
  }));
  return [...server, ...worker];
}

/**
 * Turn one probe's HTTP status into a problem, or null when it answered.
 *
 * The three failures are kept apart because they send the operator to three
 * different places: a wrong credential, a credential without permission, and a
 * family that was never switched on.
 */
export function classify(family: Family, status: number): PreflightProblem | null {
  const spec = FAMILIES[family];
  if (status >= 200 && status < 300) return null;

  if (status === 401) {
    return {
      probe: family,
      setting: 'WITHE_CE_TOKEN',
      detail:
        `The server rejected the token while checking ${spec.label}. ` +
        `WITHE_CE_TOKEN must match MEND_RNV_API_SERVER_SECRET on the server.`,
      fatal: true,
      remedies: [],
    };
  }

  if (status === 403) {
    return {
      probe: family,
      setting: 'WITHE_CE_TOKEN',
      detail:
        `The token was accepted but is not permitted to read ${spec.label}. ` +
        `If role-based access control is on, the token's owner needs access; ` +
        `otherwise use the server API secret.`,
      fatal: true,
      remedies: [],
    };
  }

  if (status === 404 || status === 501) {
    return {
      probe: family,
      setting: spec.server.join(' and '),
      detail: `The ${spec.label} API is not enabled on the server. ${spec.cost}`,
      fatal: spec.fatal,
      remedies: remediesFor(family),
    };
  }

  return {
    probe: family,
    setting: null,
    detail: `The server answered ${status} while checking ${spec.label}.`,
    fatal: spec.fatal,
    remedies: [],
  };
}

/** A Compose fragment an operator can paste, built from the problems found. */
export function composeBlock(problems: readonly PreflightProblem[]): string {
  const byTarget = new Map<string, Map<string, string>>();
  for (const problem of problems) {
    for (const remedy of problem.remedies) {
      const target = byTarget.get(remedy.target) ?? new Map<string, string>();
      target.set(remedy.variable, remedy.value);
      byTarget.set(remedy.target, target);
    }
  }
  if (byTarget.size === 0) return '';

  const lines: string[] = ['services:'];
  for (const [target, variables] of byTarget) {
    lines.push(`  ${target === 'server' ? 'renovate-server' : 'renovate-worker'}:`);
    lines.push('    environment:');
    // Plain code-point order, not localeCompare: collation rules vary by
    // machine locale, and a Compose block that reorders itself between hosts
    // produces diffs that mean nothing.
    for (const [variable, value] of [...variables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      lines.push(`      ${variable}: "${value}"`);
    }
  }
  return lines.join('\n');
}
