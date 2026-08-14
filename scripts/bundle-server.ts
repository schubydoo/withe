/**
 * Bundle the processes Next.js does not trace.
 *
 * `output: 'standalone'` copies only what Next traced from the application
 * graph. The supervisor, the worker and the TLS proxy are not in that graph, so
 * anything imported solely by them — the YAML parser behind `WITHE_CONFIG`, the
 * generated CE client, Drizzle — is absent from the image. `CMD` would then
 * crash with `MODULE_NOT_FOUND` on a deployment that used a config file, and
 * work on one that did not.
 *
 * Copying the whole `node_modules` would also fix it and cost about 200 MB.
 * Bundling costs a second.
 *
 * `better-sqlite3` stays external: it is a native addon, it cannot be bundled,
 * and the standalone output already carries it with the prebuilt binary for
 * this platform.
 */
import { build } from 'esbuild';

const EXTERNAL = ['better-sqlite3'];

const ENTRIES = [
  'src/supervisor/main.ts',
  'src/worker/main.ts',
  'src/tls-proxy/main.ts',
  'src/healthcheck.ts',
];

/** `supervisor.js`, not `main.js`: the file name is what `CMD` reads. */
function outfileFor(entry: string): string {
  const parts = entry.replace(/^src\//, '').replace(/\.ts$/, '').split('/');
  const name = parts.length > 1 ? parts[0] : parts[parts.length - 1];
  return `dist/${name}.js`;
}

const results = await Promise.all(
  ENTRIES.map((entry) =>
    build({
      entryPoints: [entry],
      outfile: outfileFor(entry),
      bundle: true,
      platform: 'node',
      // The standalone package.json says `type: module`, and the supervisor
      // uses top-level await, so this cannot be CommonJS.
      format: 'esm',
      target: 'node24',
      external: EXTERNAL,
      // CommonJS dependencies bundled into an ESM output keep their
      // `require` calls, and some are dynamic — the YAML parser reads
      // `require('process')`. Without a real `require` in scope those throw
      // "Dynamic require of ... is not supported" at import, which is a
      // crash-loop in the container and nothing at all in the tests.
      banner: {
        js: "import { createRequire as __nodeRequire } from 'node:module';\nconst require = __nodeRequire(import.meta.url);",
      },
      metafile: true,
      logLevel: 'warning',
    }).then((result) => ({ entry, result })),
  ),
);

for (const { entry, result } of results) {
  const [output] = Object.entries(result.metafile.outputs);
  if (!output) continue;
  const [file, meta] = output;
  console.log(`bundle: ${entry} → ${file}, ${Math.round(meta.bytes / 1024)} kB`);
}
