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
      // Only the organization family is fatal, because it is the only one Withe
      // cannot work without: it is the entry point to repositories and runs.
      // Withe reads no system endpoint outside preflight, and a missing job
      // family costs run history rather than the whole dashboard. Reporting
      // either as fatal would tell an operator to fix something that is not
      // stopping them.
      fatal: family === 'orgs',
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
  /** TEMPORARY(org-discovery). See SourceConfig.orgs. */
  private readonly configuredOrgs: string[] | null;

  constructor(config: SourceConfig) {
    if (!config.url) throw new Error(`Source '${config.id}' needs a url`);
    if (!config.token) throw new Error(`Source '${config.id}' needs a token`);
    this.id = config.id;
    this.config = { baseUrl: config.url, token: config.token };
    this.client = createCeClient(this.config);
    this.configuredOrgs = config.orgs?.length ? [...config.orgs] : null;
  }

  /**
   * TEMPORARY(org-discovery). Returns the organizations to enumerate.
   *
   * When names are configured, no request is made. That is the whole point of
   * the workaround and the reason a test asserts on the request rather than on
   * the result.
   */
  private async listOrgs(): Promise<
    { names: string[]; problem: PreflightProblem | null; warning: string | null }
  > {
    if (this.configuredOrgs) {
      return { names: this.configuredOrgs, problem: null, warning: null };
    }

    const response = await this.client.GET('/api/v1/orgs');
    if (response.error || !response.data) {
      return {
        names: [],
        problem: classify(response.response.status, 'orgs'),
        warning:
          `Could not list organizations (${response.response.status}). ` +
          `${FAMILY_SETTINGS.orgs} may be unset, or set WITHE_CE_ORGS to name them instead.`,
      };
    }
    return { names: (response.data as OrgMeta[]).map((org) => org.name), problem: null, warning: null };
  }

  async preflight(): Promise<PreflightResult> {
    const problems: PreflightProblem[] = [];

    const status = await this.client.GET('/system/v1/status');
    if (status.response.status >= 400) {
      problems.push(classify(status.response.status, 'system'));
    }

    const orgs = await this.listOrgs();
    if (orgs.problem) {
      problems.push(orgs.problem);
      return { ok: false, problems, reachableButEmpty: false };
    }
    if (this.configuredOrgs) {
      // A wrong name here looks exactly like an empty server, so say which mode
      // this is before the operator starts debugging the wrong thing.
      problems.push({
        probe: 'orgs',
        // Either shape can set this, and naming only the environment variable
        // would send a file-configured operator to the wrong place.
        setting: 'WITHE_CE_ORGS or sources[].orgs',
        detail: `Organizations were named by configuration, not discovered: ${orgs.names.join(', ')}.`,
        fatal: false,
      });
    }

    let repoCount = 0;
    for (const name of orgs.names) {
      const repos = await this.client.GET('/api/v1/orgs/{org}/-/repos', {
        params: { path: { org: name } },
      });
      if (repos.response.status >= 400) {
        problems.push(classify(repos.response.status, 'orgs'));
        continue;
      }
      repoCount += ((repos.data ?? []) as RepositoryInfo[]).length;
    }
    const orgCount = orgs.names.length;

    // Probing jobs needs a repository, so a server with none cannot answer the
    // question. That is reported below rather than guessed at.
    const ok = !problems.some((p) => p.fatal);
    return {
      ok,
      problems,
      reachableButEmpty: ok && orgCount > 0 && repoCount === 0,
    };
  }

  async collect(): Promise<CollectResult> {
    const warnings: string[] = [];
    const repos: Repo[] = [];

    const orgs = await this.listOrgs();
    if (orgs.warning) {
      // Without the org list there is nothing to enumerate. This is the one
      // failure the adapter cannot degrade past, so it says so and returns
      // empty rather than throwing into the worker's face.
      warnings.push(orgs.warning);
      return { repos: [], runs: [], updates: [], warnings };
    }

    for (const name of orgs.names) {
      const result = await this.client.GET('/api/v1/orgs/{org}/-/repos', {
        params: { path: { org: name } },
      });
      if (result.error || !result.data) {
        warnings.push(`Could not list repositories for ${name} (${result.response.status}).`);
        continue;
      }
      const infos = result.data as RepositoryInfo[];
      if (infos.length === 0 && this.configuredOrgs) {
        // TEMPORARY(org-discovery). The server answers 200 with an empty list
        // for an organization it has never heard of, so a typo in WITHE_CE_ORGS
        // is otherwise indistinguishable from an organization with no
        // repositories. Verified against a live server, which returned `[]` for
        // a name that does not exist. This is the cost of naming them by hand.
        warnings.push(
          `Configured organization '${name}' returned no repositories from the server. ` +
            `Check the spelling: an unknown name and an empty organization look identical here.`,
        );
      }
      for (const info of infos) {
        repos.push(mapRepo(name, info, this.id));
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
