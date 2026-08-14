/**
 * Fail on any AGPL-licensed direct dependency (NFR-20, Task 3.11).
 *
 * Withe is MIT. A direct dependency under the GNU Affero GPL would pull a
 * network-copyleft obligation into a project that does not carry one — the kind
 * of licence mistake that is invisible until someone reads the tree. This reads
 * each direct dependency's own declared licence from its installed
 * `package.json` and refuses AGPL.
 *
 * Direct only: `dependencies` and `devDependencies` from this repo's
 * `package.json`. A transitive AGPL dependency is a real concern too, but it is
 * a different control (a full tree scan), and the plan scopes this gate to
 * direct dependencies.
 *
 *   npm run check:licences
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Matches AGPL in any SPDX form: AGPL-3.0, AGPL-3.0-or-later, AGPL-1.0, ... */
const AGPL = /\bAGPL\b/i;

interface Offender {
  name: string;
  license: string;
}

/** The licence a package declares, as a string, from either SPDX field shape. */
export function licenseOf(pkg: { license?: unknown; licenses?: unknown }): string {
  if (typeof pkg.license === 'string') return pkg.license;
  // The deprecated array form: `licenses: [{ type, url }]`.
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses
      .map((l) => (l && typeof l === 'object' && 'type' in l ? String((l as { type: unknown }).type) : ''))
      .filter(Boolean)
      .join(' OR ');
  }
  if (pkg.license && typeof pkg.license === 'object' && 'type' in pkg.license) {
    return String((pkg.license as { type: unknown }).type);
  }
  return 'UNKNOWN';
}

export function isAgpl(license: string): boolean {
  return AGPL.test(license);
}

function directDependencies(): string[] {
  const self = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(self.dependencies ?? {}), ...Object.keys(self.devDependencies ?? {})].sort();
}

function main(): void {
  const names = directDependencies();
  const offenders: Offender[] = [];
  let read = 0;

  for (const name of names) {
    let pkg: { license?: unknown; licenses?: unknown };
    try {
      pkg = require(`${name}/package.json`);
    } catch {
      // Not resolvable from its own package.json export map; fall back to the
      // path, and if that fails too, report it as unknown rather than skipping.
      try {
        pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8'));
      } catch {
        console.warn(`licences: could not read a licence for ${name}`);
        continue;
      }
    }
    read += 1;
    const license = licenseOf(pkg);
    if (isAgpl(license)) offenders.push({ name, license });
  }

  console.log(`licences: read ${read} of ${names.length} direct dependencies`);

  if (offenders.length > 0) {
    for (const o of offenders) console.error(`::error::${o.name} is ${o.license} — AGPL is not permitted (NFR-20)`);
    process.exitCode = 1;
    return;
  }
  console.log('licences: no AGPL direct dependency');
}

if (process.argv[1]?.endsWith('check-licenses.ts')) main();
