/**
 * Reads a self-hosted Renovate server's API.
 *
 * Every call here is a read. The specification contains four write operations
 * and this adapter reaches none of them (NFR-11).
 */
import type { RenovateRun, Repo, Update } from '../../core/model.ts';
import { webBaseFrom } from '../../core/links.ts';
import { extractFromLog } from '../../core/renovate-log.ts';
import { registerAdapter } from '../registry.ts';
import type {
  CollectResult,
  PreflightProblem,
  PreflightResult,
  SourceAdapter,
  SourceConfig,
  SourceMeta,
} from '../types.ts';
import { createCeClient, paginate, type CeClientConfig } from './client.ts';
import { mapWithLimit } from './limit.ts';
import { mapRepo, mapRun } from './map.ts';
import { classify, composeBlock, type Family } from './preflight.ts';
import type { components } from './generated/ce.d.ts';

type JobReport = components['schemas']['JobReport'];

/** Section 4.3. Also a contractual limit, not only courtesy. */
const CONCURRENCY = 4;

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
      const problem = classify('inventory', response.response.status);
      return {
        names: [],
        problem,
        // The detail says what broke; the setting says what to change. A log
        // line carrying only the first leaves the operator with nowhere to go.
        warning: problem
          ? `${problem.detail}${problem.setting ? ` Set ${problem.setting}.` : ''}`
          : `Could not list organizations (${response.response.status}).`,
      };
    }
    return { names: response.data.map((org) => org.name), problem: null, warning: null };
  }

  async preflight(): Promise<PreflightResult> {
    const problems: PreflightProblem[] = [];
    const add = (family: Family, status: number) => {
      const problem = classify(family, status);
      if (problem) problems.push(problem);
      return problem === null;
    };

    // Every family is probed, even after one fails. An operator fixing three
    // settings wants all three named in one pass, not one per restart.
    const status = await this.client.GET('/system/v1/status');
    add('system', status.response.status);

    const metrics = await this.rawGet('/metrics');
    add('metrics', metrics);

    const orgs = await this.listOrgs();
    if (orgs.problem) {
      problems.push(orgs.problem);
      return { ok: false, problems, reachableButEmpty: false, compose: composeBlock(problems) };
    }
    if (this.configuredOrgs) {
      problems.push({
        probe: 'inventory',
        // Either shape can set this, and naming only the environment variable
        // would send a file-configured operator to the wrong place.
        setting: 'WITHE_CE_ORGS or sources[].orgs',
        detail: `Organizations were named by configuration, not discovered: ${orgs.names.join(', ')}.`,
        fatal: false,
        remedies: [],
      });
    }

    let repoCount = 0;
    let firstRepo: string | null = null;
    for (const name of orgs.names) {
      const repos = await this.client.GET('/api/v1/orgs/{org}/-/repos', {
        params: { path: { org: name } },
      });
      if (!add('inventory', repos.response.status)) continue;
      const list = repos.data ?? [];
      repoCount += list.length;
      firstRepo ??= list[0]?.fullName ?? null;
    }

    // The run-history probe needs a repository to aim at, so a server with none
    // cannot answer it. Reporting that as a failure would blame the operator
    // for an empty fleet.
    if (firstRepo) {
      const jobs = await this.client.GET('/api/v1/repos/{orgRepo}/-/jobs', {
        params: { path: { orgRepo: firstRepo } },
      });
      add('jobs', jobs.response.status);
    }

    const ok = !problems.some((p) => p.fatal);
    return {
      ok,
      problems,
      reachableButEmpty: ok && orgs.names.length > 0 && repoCount === 0,
      compose: composeBlock(problems),
    };
  }

  /** A plain fetch for endpoints outside the generated specification. */
  private async rawGet(path: string): Promise<number> {
    try {
      const response = await fetch(new URL(path.replace(/^\//, ''), this.config.baseUrl.replace(/\/$/, '') + '/'), {
        headers: { Authorization: `Bearer ${this.config.token}` },
        redirect: 'manual',
      });
      return response.status;
    } catch {
      return 0;
    }
  }

  async collect(): Promise<CollectResult> {
    const warnings: string[] = [];
    const repos: Repo[] = [];
    // Whether every repository's runs were enumerated. Losing an org, a repo
    // listing, or one repository's run pages clears it; a failed log fetch
    // does not — the runs themselves were still fully read.
    let complete = true;

    const orgs = await this.listOrgs();
    if (orgs.warning) {
      // Without the org list there is nothing to enumerate. This is the one
      // failure the adapter cannot degrade past, so it says so and returns
      // empty rather than throwing into the worker's face.
      warnings.push(orgs.warning);
      return { repos: [], runs: [], updates: [], warnings, complete: false, authoritativeRepoList: true };
    }

    for (const name of orgs.names) {
      const result = await this.client.GET('/api/v1/orgs/{org}/-/repos', {
        params: { path: { org: name } },
      });
      if (result.error || !result.data) {
        const problem = classify('inventory', result.response.status);
        warnings.push(
          problem
            ? `${name}: ${problem.detail}${problem.setting ? ` Set ${problem.setting}.` : ''}`
            : `Could not list repositories for ${name} (${result.response.status}).`,
        );
        complete = false;
        continue;
      }
      const infos = result.data;
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
        complete = false;
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

    return {
      repos,
      runs: runsPerRepo.flat(),
      updates: updatesPerRepo.flat(),
      warnings,
      complete,
      // The org repo listing is the full set of repositories, so an absent one
      // has been uninstalled or made private.
      authoritativeRepoList: true,
      meta: await this.forge(),
    };
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

  /**
   * Which forge this server works against, and where a person can open it.
   *
   * The status endpoint reports an API endpoint, which is not browsable. A
   * server with the system family switched off simply yields nothing, and the
   * pages fall back to plain text.
   */
  private async forge(): Promise<SourceMeta | undefined> {
    const status = await this.client.GET('/system/v1/status');
    if (status.error || !status.data) return undefined;
    const data = status.data as {
      platform?: string;
      endpoint?: string;
      scheduler?: { allJobs?: { cron?: string; lastScheduling?: string } };
    };
    const platform = data.platform ?? null;
    const webBaseUrl = webBaseFrom(platform, data.endpoint ?? null);
    const job = data.scheduler?.allJobs;
    const scheduleCron = job?.cron ?? null;
    const scheduleLastAt = job?.lastScheduling ? new Date(job.lastScheduling) : null;
    // Any one of these is worth keeping; a server that reports only a schedule
    // must not be dropped for having no browsable forge URL.
    return platform || webBaseUrl || scheduleCron
      ? { platform, webBaseUrl, scheduleCron, scheduleLastAt }
      : undefined;
  }

  private async collectUpdates(repo: Repo, run: RenovateRun): Promise<Update[]> {
    const stream = await this.fetchLog(run);
    // Streamed and parsed as it arrives. A log is hundreds of kilobytes and is
    // never stored — PRD Section 6.3.1.
    const extract = await extractFromLog(stream, {
      repoId: repo.id,
      sourceAdapterId: this.id,
      detectedAt: run.completedAt ?? run.startedAt ?? new Date(),
    });
    if (extract.runnerVersion) run.runnerVersion = extract.runnerVersion;
    return extract.updates;
  }

  async fetchLog(run: Pick<RenovateRun, 'repoId' | 'externalJobId'>): Promise<ReadableStream<Uint8Array>> {
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
