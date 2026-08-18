/**
 * Configuration, in two shapes with one result.
 *
 * Flat environment variables describe one source. A mounted file describes
 * many. Both produce the same `SourceConfig[]`, which is why adding the second
 * adapter in v1.1 needs no breaking change — the flat form is shorthand for a
 * one-entry list (AD-3).
 */
import { existsSync, readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import type { SourceConfig, SourceKind } from '../adapters/types.ts';
import { fillCompareTemplate } from '../core/links.ts';
import { bindAddress, exposureWarning, inContainer, systemProbe, type ContainerProbe, type Env } from './exposure.ts';

export class ConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ConfigError';
    this.field = field;
  }
}

export interface WitheConfig {
  sources: SourceConfig[];
  dbPath: string;
  configPath: string;
  syncIntervalSeconds: number;
  stalledAfterDays: number;
  /** Unset means keep run history indefinitely (PRD Section 6.3.1). */
  retentionDays: number | null;
  /** An operator's compare-link template (B-6), or null to use the forge's own.
   * Placeholders {repo}, {from}, {to} are filled URL-encoded. */
  compareUrl: string | null;
  auth: { user: string; pass: string } | null;
  tls: { cert: string; key: string } | null;
  /** True when Withe is running in a container, which decides `bind`. */
  container: boolean;
  /** Where Withe answers: the TLS proxy when there is one, the web server otherwise. */
  bind: string;
  port: number;
  /** Where the Next.js server itself listens, which is not the same behind TLS. */
  webBind: string;
  webPort: number;
  /** Things the operator should know at startup but which are not fatal. */
  warnings: string[];
}

const DEFAULTS = {
  dbPath: '/data/withe.db',
  configPath: '/data/withe.yaml',
  syncIntervalSeconds: 300,
  stalledAfterDays: 7,
  port: 3000,
} as const;

const KNOWN_KINDS: readonly string[] = ['ce', 'jsonlog', 'forge'];

export function loadConfig(env: Env = process.env, probe: ContainerProbe = systemProbe): WitheConfig {
  const warnings: string[] = [];

  const configPath = env.WITHE_CONFIG ?? DEFAULTS.configPath;
  const hasFile = existsSync(configPath);

  const sources = hasFile
    ? fromFile(configPath, env, warnings)
    : fromEnvironment(env);

  if (hasFile && (env.WITHE_CE_URL || env.WITHE_CE_TOKEN)) {
    // The file wins. Saying so at startup is the difference between an
    // operator finding this in a minute and finding it in an hour.
    warnings.push(
      `${configPath} exists, so WITHE_CE_URL and WITHE_CE_TOKEN are ignored. ` +
        `Delete the file to use the flat variables.`,
    );
  }

  const auth = authFrom(env);
  const tls = tlsFrom(env);
  const container = inContainer(env, probe);
  const bind = bindAddress(env, container);
  const port = positive(env, 'WITHE_PORT', DEFAULTS.port);

  // NFR-13b. The operator is told once at startup and again on every page,
  // because a warning scrolled past during a container start is a warning
  // nobody read.
  const exposed = exposureWarning(bind, auth !== null);
  if (exposed) warnings.push(exposed);

  return {
    sources,
    dbPath: env.WITHE_DB_PATH ?? DEFAULTS.dbPath,
    configPath,
    syncIntervalSeconds: positive(env, 'WITHE_SYNC_INTERVAL_SECONDS', DEFAULTS.syncIntervalSeconds),
    stalledAfterDays: positive(env, 'WITHE_STALLED_AFTER_DAYS', DEFAULTS.stalledAfterDays),
    retentionDays: env.WITHE_RETENTION_DAYS ? positive(env, 'WITHE_RETENTION_DAYS', 0) : null,
    compareUrl: compareUrlFrom(env, warnings),
    auth,
    tls,
    container,
    bind,
    port,
    // Behind TLS the proxy answers on the configured address and the Next
    // server moves to loopback one port up, where only the proxy can reach it.
    // AD-2: standalone output emits its own server and supports no custom one,
    // so TLS cannot be terminated inside the web process.
    webBind: tls ? '127.0.0.1' : bind,
    webPort: tls ? port + 1 : port,
    warnings,
  };
}

/** The flat form: one source, always called `default`. */
function fromEnvironment(env: Env): SourceConfig[] {
  const url = env.WITHE_CE_URL;
  const token = env.WITHE_CE_TOKEN;
  if (!url && !token) return [];
  if (!url) throw new ConfigError('WITHE_CE_URL', 'is required when WITHE_CE_TOKEN is set');
  if (!token) throw new ConfigError('WITHE_CE_TOKEN', 'is required when WITHE_CE_URL is set');

  // TEMPORARY(org-discovery). See SourceConfig.orgs and tad.md Section 7.7.2.
  const orgs = splitList(env.WITHE_CE_ORGS);

  return [{ id: 'default', kind: 'ce', url, token, ...(orgs ? { orgs } : {}) }];
}

interface RawSource {
  id?: unknown;
  kind?: unknown;
  url?: unknown;
  path?: unknown;
  token?: unknown;
  tokenEnv?: unknown;
  orgs?: unknown;
}

function fromFile(path: string, env: Env, warnings: string[]): SourceConfig[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(path, `is not valid YAML: ${describe(cause)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError(path, 'must be a mapping with a `sources` list');
  }
  const raw = (parsed as { sources?: unknown }).sources;
  if (!Array.isArray(raw)) {
    throw new ConfigError('sources', 'must be a list');
  }
  if (raw.length === 0) {
    warnings.push(`${path} lists no sources, so Withe has nothing to read.`);
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => readSource(entry as RawSource, index, env, seen));
}

function readSource(entry: RawSource, index: number, env: Env, seen: Set<string>): SourceConfig {
  const where = `sources[${index}]`;
  if (!entry || typeof entry !== 'object') throw new ConfigError(where, 'must be a mapping');

  const id = requireString(entry.id, `${where}.id`);
  if (seen.has(id)) {
    // Ids are the join key for every row in the database. Two sources sharing
    // one would silently merge two fleets.
    throw new ConfigError(`${where}.id`, `'${id}' is used more than once; ids must be unique`);
  }
  seen.add(id);

  const kind = requireString(entry.kind, `${where}.kind`);
  if (!KNOWN_KINDS.includes(kind)) {
    throw new ConfigError(`${where}.kind`, `'${kind}' is not one of ${KNOWN_KINDS.join(', ')}`);
  }

  if (entry.token !== undefined) {
    // The file is meant to be safe to paste into a forum post when asking for
    // help. Accepting a literal secret quietly would make that untrue.
    throw new ConfigError(
      `${where}.token`,
      'must not hold a secret. Use `tokenEnv` to name an environment variable instead.',
    );
  }

  const config: SourceConfig = { id, kind: kind as SourceKind };

  if (entry.url !== undefined) config.url = requireString(entry.url, `${where}.url`);
  if (entry.path !== undefined) config.path = requireString(entry.path, `${where}.path`);

  if (entry.tokenEnv !== undefined) {
    const name = requireString(entry.tokenEnv, `${where}.tokenEnv`);
    const value = env[name];
    if (!value) {
      throw new ConfigError(`${where}.tokenEnv`, `names ${name}, which is not set`);
    }
    config.token = value;
  }

  // TEMPORARY(org-discovery). See SourceConfig.orgs and tad.md Section 7.7.2.
  if (entry.orgs !== undefined) {
    if (!Array.isArray(entry.orgs) || entry.orgs.some((o) => typeof o !== 'string')) {
      throw new ConfigError(`${where}.orgs`, 'must be a list of strings');
    }
    config.orgs = entry.orgs as string[];
  }

  if (kind === 'ce') {
    if (!config.url) throw new ConfigError(`${where}.url`, 'is required for a ce source');
    if (!config.token) throw new ConfigError(`${where}.tokenEnv`, 'is required for a ce source');
  }

  return config;
}

function compareUrlFrom(env: Env, warnings: string[]): string | null {
  const raw = env.WITHE_COMPARE_URL;
  if (!raw || raw.trim() === '') return null;
  const template = raw.trim();
  // A template that names no placeholder — or misspells all of them — passes the
  // http(s) check below (it is a valid URL) but would send every dependency to
  // the same page. Catch that first, since the URL check cannot.
  if (!/\{(repo|from|to)\}/.test(template)) {
    warnings.push(
      'WITHE_COMPARE_URL names none of the placeholders {repo}, {from}, {to}, so every ' +
        'compare link would point at the same page. Ignoring it; compare links use the forge.',
    );
    return null;
  }
  // Prove it makes a real address before trusting it, with sample values. A
  // broken preference falls back to the forge's own compare link rather than
  // taking the page down.
  if (fillCompareTemplate(template, 'owner/repo', '1.0.0', '2.0.0') === null) {
    warnings.push(
      'WITHE_COMPARE_URL is not a usable http(s) template, so compare links use the forge. ' +
        'Use the placeholders {repo}, {from}, {to}, for example ' +
        'https://octochangelog.com/compare?repo={repo}&from={from}&to={to}',
    );
    return null;
  }
  return template;
}

function authFrom(env: Env): WitheConfig['auth'] {
  const user = env.WITHE_AUTH_USER;
  const pass = env.WITHE_AUTH_PASS;
  if (!user && !pass) return null;
  // Half-configured authentication is the shape that leaves a dashboard open
  // while its operator believes it is closed.
  if (!user) throw new ConfigError('WITHE_AUTH_USER', 'is required when WITHE_AUTH_PASS is set');
  if (!pass) throw new ConfigError('WITHE_AUTH_PASS', 'is required when WITHE_AUTH_USER is set');
  return { user, pass };
}

function tlsFrom(env: Env): WitheConfig['tls'] {
  const cert = env.WITHE_TLS_CERT;
  const key = env.WITHE_TLS_KEY;
  if (!cert && !key) return null;
  if (!cert) throw new ConfigError('WITHE_TLS_CERT', 'is required when WITHE_TLS_KEY is set');
  if (!key) throw new ConfigError('WITHE_TLS_KEY', 'is required when WITHE_TLS_CERT is set');
  return { cert, key };
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(name, `must be a positive number, not '${raw}'`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(field, 'must be a non-empty string');
  }
  return value.trim();
}

function splitList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const items = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
