import { createAdapter } from '../../adapters/register.ts';
import type { PreflightResult } from '../../adapters/types.ts';
import { ConfigError, loadConfig } from '../../config/load.ts';
import { CopyButton } from './copy-button.tsx';
import { reprobe } from './actions.ts';

// Probed live on every view. This is the one page that talks to the source
// while rendering, because its whole job is to say what is reachable now.
export const dynamic = 'force-dynamic';

interface Probed {
  id: string;
  result: PreflightResult | null;
  error: string | null;
}

async function probe(): Promise<{ probed: Probed[]; warnings: string[]; configError: string | null }> {
  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    return {
      probed: [],
      warnings: [],
      configError: cause instanceof ConfigError ? cause.message : String(cause),
    };
  }

  const probed = await Promise.all(
    config.sources.map(async (source): Promise<Probed> => {
      try {
        return { id: source.id, result: await createAdapter(source).preflight(), error: null };
      } catch (cause) {
        // An unreachable host throws rather than answering, and that is the
        // most common first-run failure of all.
        return { id: source.id, result: null, error: describe(cause) };
      }
    }),
  );

  return { probed, warnings: config.warnings, configError: null };
}

/**
 * The readable reason a request failed.
 *
 * `fetch` throws a bare 'fetch failed' and puts the real cause underneath, so
 * showing only the outer message tells an operator nothing. The cause names the
 * refused connection, the unknown host, or the expired certificate.
 */
function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const inner: unknown = cause.cause;
  if (inner instanceof Error && inner.message) return `${cause.message}: ${inner.message}`;
  return cause.message;
}

function Unconfigured() {
  const sample = [
    'services:',
    '  withe:',
    '    image: ghcr.io/schubydoo/withe',
    '    environment:',
    '      WITHE_CE_TOKEN: "your MEND_RNV_API_SERVER_SECRET"',
    '      WITHE_CE_URL: "http://renovate-server:8080"',
  ].join('\n');

  return (
    <section className="mt-6">
      <h2 className="text-lg font-medium">No Renovate server is configured yet</h2>
      <p className="mt-2 text-sm text-neutral-600">
        Withe reads a Renovate deployment you already run. Point it at one with two settings, or
        write a config file at <code>WITHE_CONFIG</code> to describe several.
      </p>
      <Block title="Add this to your Compose file" text={sample} />
      <p className="mt-3 text-sm text-neutral-600">
        <code>WITHE_CE_TOKEN</code> is the value of <code>MEND_RNV_API_SERVER_SECRET</code> on the
        Renovate server. Withe only ever reads.
      </p>
    </section>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div className="mt-3 rounded border border-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-3 py-1.5">
        <span className="text-xs font-medium text-neutral-600">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">{text}</pre>
    </div>
  );
}

function Source({ probed }: { probed: Probed }) {
  const { id, result, error } = probed;

  if (error) {
    return (
      <section className="mt-6 rounded border border-neutral-200 p-4">
        <h2 className="font-medium">
          {id} <span className="font-normal text-neutral-500">— unreachable</span>
        </h2>
        <p className="mt-2 text-sm text-neutral-700">{error}</p>
        <p className="mt-2 text-sm text-neutral-500">
          Check <code>WITHE_CE_URL</code>. From inside a container, <code>localhost</code> is the
          container itself, not the host.
        </p>
      </section>
    );
  }

  if (!result) return null;
  const fatal = result.problems.filter((p) => p.fatal);
  const notes = result.problems.filter((p) => !p.fatal);

  return (
    <section className="mt-6 rounded border border-neutral-200 p-4">
      <h2 className="font-medium">
        {id}{' '}
        <span className={result.ok ? 'font-normal text-green-700' : 'font-normal text-red-700'}>
          {result.ok ? '— reachable' : '— not usable yet'}
        </span>
      </h2>

      {result.reachableButEmpty && (
        <p className="mt-2 text-sm text-neutral-700">
          The server answered, and reports no repositories onboarded. Withe has nothing to show until
          Renovate is installed on at least one repository. This is not a Withe problem.
        </p>
      )}

      {result.ok && result.problems.length === 0 && (
        <p className="mt-2 text-sm text-neutral-600">Everything Withe reads is enabled.</p>
      )}

      {[...fatal, ...notes].map((problem) => (
        <div key={`${problem.probe}-${problem.detail}`} className="mt-3">
          <p className="text-sm">
            <span
              className={
                problem.fatal
                  ? 'mr-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800'
                  : 'mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700'
              }
            >
              {problem.fatal ? 'blocking' : 'optional'}
            </span>
            {problem.detail}
          </p>
          {problem.remedies.length > 0 && (
            <ul className="mt-1 ml-4 list-disc text-sm text-neutral-600">
              {problem.remedies.map((remedy) => (
                <li key={remedy.variable}>
                  <code>
                    {remedy.variable}={remedy.value}
                  </code>{' '}
                  on the Renovate {remedy.target}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {result.compose && <Block title="Set these, then probe again" text={result.compose} />}
    </section>
  );
}

export default async function Preflight() {
  const { probed, warnings, configError } = await probe();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Withe — setup check</h1>
        <form action={reprobe}>
          <button
            type="submit"
            className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100"
          >
            Probe again
          </button>
        </form>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Probed just now. Change a setting on the Renovate server, then probe again — nothing here
        needs Withe restarted.
      </p>

      {configError && (
        <p className="mt-6 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Configuration is invalid: {configError}
        </p>
      )}

      {warnings.map((warning) => (
        <p
          key={warning}
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {warning}
        </p>
      ))}

      {!configError && probed.length === 0 && <Unconfigured />}
      {probed.map((source) => (
        <Source key={source.id} probed={source} />
      ))}

      {probed.some((p) => p.result?.ok) && (
        <p className="mt-8 text-sm">
          <a className="underline" href="/">
            Go to the dashboard
          </a>
        </p>
      )}
    </main>
  );
}
