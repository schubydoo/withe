/**
 * Reads a self-hosted Renovate server's API.
 *
 * Every call here is a read. The specification contains four write operations
 * and this adapter reaches none of them (NFR-11).
 */
import type { RenovateRun, Repo, Update } from '../../core/model.ts';
import { extractFromLog } from '../../core/renovate-log.ts';
import { registerAdapter } from '../registry.ts';
import type {
  CollectResult,
  PreflightProblem,
  PreflightResult,
  SourceAdapter,
  SourceConfig,
} from '../types.ts';
import { createCeClient, paginate, type CeClientConfig } from './client.ts';
import { mapWithLimit } from './limit.ts';
import { mapRepo, mapRun } from './map.ts';
import type { components } from './generated/ce.d.ts';

type OrgMeta = components['schemas']['OrgMeta'];
type RepositoryInfo = components['schemas']['RepositoryInfo'];
type JobReport = components['schemas']['JobReport'];

/** Section 4.3. Also a contractual limit, not only courtesy. */
const CONCURRENCY = 4;

/**
 * Which setting explains a family being unreachable.
 *
 * Metric M-5 wants the exact variable named, and a 404 on one family says
 * nothing about the others, so each is probed and reported separately.
 */
const FAMILY_SETTINGS = {
  system: 'MEND_RNV_API_ENABLED or MEND_RNV_API_ENABLE_SYSTEM',
  orgs: 'MEND_RNV_API_ENABLED',
  jobs: 'MEND_RNV_API_ENABLE_JOBS',
} as const;

/** Distinguish "you are not allowed" from "this family is switched off". */
function classify(status: number, family: keyof typeof FAMILY_SETTINGS): PreflightProblem {
  if (status === 401) {
    return {
      probe: family,
      setting: null,
      detail: 'The server rejected the token. Check WITHE_CE_TOKEN against MEND_RNV_API_SERVER_SECRET.',
      fatal: true,
    };
  }
  if (status === 403) {
    return {
      probe: family,
      setting: null,
      detail: 'The token is accepted but not permitted here. Check its scope.',
      fatal: true,
    };
  }
  if (status === 404 || status === 501) {
    return {
      probe: family,
      setting: FAMILY_SETTINGS[family],
      detail: `The ${family} API is not enabled on this server.`,
      fatal: family !== 'jobs',
    };
  }
  return {
    probe: family,
    setting: null,
    detail: `The server answered ${status}.`,
    fatal: true,
  };
}

export class CeAdapter implements SourceAdapter {
  readonly id: string;
  readonly kind = 'ce' as const;

  private readonly config: CeClientConfig;
  private readonly client: ReturnType<typeof createCeClient>;

  constructor(config: SourceConfig) {
    if (!config.url) throw new Error(`Source '${config.id}' needs a url`);
    if (!config.token) throw new Error(`Source '${config.id}' needs a token`);
    this.id = config.id;
    this.config = { baseUrl: config.url, token: config.token };
    this.client = createCeClient(this.config);
  }

  async preflight(): Promise<PreflightResult> {
    const problems: PreflightProblem[] = [];

    const status = await this.client.GET('/system/v1/status');
    if (status.response.status >= 400) {
      problems.push(classify(status.response.status, 'system'));
    }

    const orgs = await this.client.GET('/api/v1/orgs');
    if (orgs.response.status >= 400) {
      problems.push(classify(orgs.response.status, 'orgs'));
      return { ok: false, problems, reachableButEmpty: false };
    }

    const orgList = (orgs.data ?? []) as OrgMeta[];
    let repoCount = 0;
    for (const org of orgList) {
      const repos = await this.client.GET('/api/v1/orgs/{org}/-/repos', {
        params: { path: { org: org.name } },
      });
      if (repos.response.status >= 400) {
        problems.push(classify(repos.response.status, 'orgs'));
        continue;
      }
      repoCount += ((repos.data ?? []) as RepositoryInfo[]).length;
    }

    // Probing jobs needs a repository, so a server with none cannot answer the
    // question. That is reported below rather than guessed at.
    const ok = !problems.some((p) => p.fatal);
    return {
      ok,
      problems,
      reachableButEmpty: ok && orgList.length > 0 && repoCount === 0,
    };
  }

  async collect(): Promise<CollectResult> {
    const warnings: string[] = [];
    const repos: Repo[] = [];

    const orgs = await this.client.GET('/api/v1/orgs');
    if (orgs.error || !orgs.data) {
      // Without the org list there is nothing to enumerate. This is the one
      // failure the adapter cannot degrade past, so it says so and returns
      // empty rather than throwing into the worker's face.
      warnings.push(
        `Could not list organizations (${orgs.response.status}). ${FAMILY_SETTINGS.orgs} may be unset.`,
      );
      return { repos: [], runs: [], updates: [], warnings };
    }

    for (const org of orgs.data as OrgMeta[]) {
      const result = await this.client.GET('/api/v1/orgs/{org}/-/repos', {
        params: { path: { org: org.name } },
      });
      if (result.error || !result.data) {
        warnings.push(`Could not list repositories for ${org.name} (${result.response.status}).`);
        continue;
      }
      for (const info of result.data as RepositoryInfo[]) {
        repos.push(mapRepo(org.name, info, this.id));
      }
    }

    const runsPerRepo = await mapWithLimit(repos, CONCURRENCY, async (repo) => {
      try {
        return await this.collectRuns(repo);
      } catch (cause) {
        warnings.push(`Could not read runs for ${repo.fullName}: ${describe(cause)}`);
        return [];
      }
    });

    // Pending updates come from the newest finished run's log, because the
    // server's API reserves them for its paid tier while the log states them
    // outright. Only the newest run is read: an older one describes a state
    // that has already been superseded.
    const updatesPerRepo = await mapWithLimit(runsPerRepo, CONCURRENCY, async (runs, index) => {
      const repo = repos[index];
      const newest = newestFinished(runs);
      if (!repo || !newest) return [];
      try {
        return await this.collectUpdates(repo, newest);
      } catch (cause) {
        warnings.push(`Could not read updates for ${repo.fullName}: ${describe(cause)}`);
        return [];
      }
    });

    return { repos, runs: runsPerRepo.flat(), updates: updatesPerRepo.flat(), warnings };
  }

  private async collectRuns(repo: Repo): Promise<RenovateRun[]> {
    const path = `/api/v1/repos/${encodeURIComponent(repo.fullName)}/-/jobs`;
    const runs: RenovateRun[] = [];
    // Pagination belongs to Task 1.3's helper. It follows Link: rel="next" and
    // refuses any target that leaves the configured server.
    for await (const page of paginate<JobReport>(this.config, path)) {
      for (const job of page) {
        const run = mapRun(repo.id, job, this.id);
        if (run) runs.push(run);
      }
    }
    return runs;
  }

  private async collectUpdates(repo: Repo, run: RenovateRun): Promise<Update[]> {
    const stream = await this.fetchLog(run);
    // Streamed and parsed as it arrives. A log is hundreds of kilobytes and is
    // never stored — PRD Section 6.3.1.
    const extract = await extractFromLog(stream as unknown as AsyncIterable<Uint8Array>, {
      repoId: repo.id,
      sourceAdapterId: this.id,
      detectedAt: run.completedAt ?? run.startedAt ?? new Date(),
    });
    if (extract.runnerVersion) run.runnerVersion = extract.runnerVersion;
    return extract.updates;
  }

  async fetchLog(run: RenovateRun): Promise<ReadableStream<Uint8Array>> {
    // The log body is this endpoint's response. There is no /logs sub-path;
    // that URL answers 404 with a message about libyears.
    const [, fullName] = run.repoId.split(/:(.*)/s);
    const path =
      `/api/v1/repos/${encodeURIComponent(fullName ?? '')}/-/jobs/` +
      encodeURIComponent(run.externalJobId);
    const url = new URL(path.replace(/^\//, ''), this.config.baseUrl.replace(/\/$/, '') + '/');

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      redirect: 'manual',
    });
    if (!response.ok || !response.body) {
      throw new Error(`Could not fetch the log for run ${run.externalJobId} (${response.status})`);
    }
    return response.body;
  }
}

/** The newest run that finished, so its log describes the current state. */
function newestFinished(runs: readonly RenovateRun[]): RenovateRun | null {
  let newest: RenovateRun | null = null;
  for (const run of runs) {
    if (!run.completedAt) continue;
    if (!newest?.completedAt || run.completedAt > newest.completedAt) newest = run;
  }
  return newest;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

registerAdapter('ce', (config) => new CeAdapter(config));
