/**
 * Where a row points.
 *
 * Every link is built from a base the operator's own deployment reported plus a
 * value that came from the source. Nothing here assumes github.com, because a
 * self-hosted forge is exactly the deployment Withe is for.
 *
 * Anything that cannot be turned into a real address returns null, and the page
 * renders plain text. A link that 404s is worse than no link: it looks like
 * Withe lost the thing.
 */

/**
 * Turn a source's API endpoint into the address a person can open.
 *
 * The Renovate server reports its platform's API endpoint — `https://api.github.com/`
 * for GitHub, or `https://ghe.example/api/v3/` for an enterprise install. Neither
 * is browsable.
 */
export function webBaseFrom(platform: string | null, endpoint: string | null): string | null {
  if (!endpoint) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }

  if (platform === 'github' || url.hostname === 'api.github.com') {
    if (url.hostname === 'api.github.com') return 'https://github.com';
    // Enterprise Server puts the API under /api/v3 on the same host.
    return `${url.protocol}//${url.host}`;
  }

  // GitLab and Bitbucket serve their API under the same host as the site.
  return `${url.protocol}//${url.host}`;
}

/**
 * Encode a path, refusing anything a browser would resolve elsewhere.
 *
 * `encodeURIComponent` leaves a dot alone, so `acme/../../evil` survives it
 * intact and the browser resolves the result to a different repository. A link
 * that goes somewhere other than it reads is worse than no link.
 */
function path(value: string): string | null {
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments.map(encodeURIComponent).join('/');
}

/** `https://github.com/acme/widget`, or null when the forge is unknown. */
export function repoUrl(webBase: string | null, fullName: string): string | null {
  if (!webBase || !fullName.includes('/')) return null;
  const encoded = path(fullName);
  return encoded === null ? null : `${webBase}/${encoded}`;
}

/** The pull request, on whichever forge this source uses. */
export function pullRequestUrl(
  webBase: string | null,
  platform: string | null,
  fullName: string,
  number: number | null,
): string | null {
  const repo = repoUrl(webBase, fullName);
  if (!repo || number === null || !Number.isInteger(number) || number <= 0) return null;
  // GitLab calls them merge requests and routes them differently.
  const segment = platform === 'gitlab' ? '-/merge_requests' : 'pull';
  return `${repo}/${segment}/${number}`;
}

export interface DependencyLink {
  href: string;
  /** What the operator will see there, so the page can say so. */
  kind: 'compare' | 'package';
}

/**
 * Where to read what changed between two versions.
 *
 * A comparison is only offered where the datasource identifies a git repository
 * and both versions are known, because that is the only case where the forge can
 * actually diff them. Everything else goes to the package page, which at least
 * carries a changelog most of the time.
 */
export function dependencyLink(
  datasource: string | null,
  packageName: string | null,
  currentVersion: string | null,
  targetVersion: string | null,
  compareTemplate: string | null = null,
): DependencyLink | null {
  if (!packageName) return null;
  const name = packageName.trim();
  if (name === '') return null;

  switch (datasource) {
    case 'github-tags':
    case 'github-releases': {
      if (!name.includes('/')) return null;
      const encoded = path(name);
      if (encoded === null) return null;
      const repo = `https://github.com/${encoded}`;
      if (currentVersion && targetVersion && currentVersion !== targetVersion) {
        const templated =
          compareTemplate && fillCompareTemplate(compareTemplate, name, currentVersion, targetVersion);
        return {
          href:
            templated ||
            `${repo}/compare/${encodeURIComponent(currentVersion)}...${encodeURIComponent(targetVersion)}`,
          kind: 'compare',
        };
      }
      return { href: repo, kind: 'package' };
    }

    case 'gitlab-tags':
    case 'gitlab-releases': {
      if (!name.includes('/')) return null;
      const encoded = path(name);
      if (encoded === null) return null;
      const repo = `https://gitlab.com/${encoded}`;
      if (currentVersion && targetVersion && currentVersion !== targetVersion) {
        const templated =
          compareTemplate && fillCompareTemplate(compareTemplate, name, currentVersion, targetVersion);
        return {
          href:
            templated ||
            `${repo}/-/compare/${encodeURIComponent(currentVersion)}...${encodeURIComponent(targetVersion)}`,
          kind: 'compare',
        };
      }
      return { href: repo, kind: 'package' };
    }

    case 'npm':
      return { href: `https://www.npmjs.com/package/${encodeName(name)}`, kind: 'package' };
    case 'pypi':
      return { href: `https://pypi.org/project/${encodeURIComponent(name)}/`, kind: 'package' };
    case 'crate':
      return { href: `https://crates.io/crates/${encodeURIComponent(name)}`, kind: 'package' };
    case 'go': {
      const encoded = path(name);
      return encoded === null ? null : { href: `https://pkg.go.dev/${encoded}`, kind: 'package' };
    }
    case 'packagist':
      return { href: `https://packagist.org/packages/${encodeName(name)}`, kind: 'package' };
    case 'rubygems':
      return { href: `https://rubygems.org/gems/${encodeURIComponent(name)}`, kind: 'package' };
    case 'docker': {
      // Only Docker Hub can be addressed without knowing the registry, and a
      // bare name or one library/ prefix is what Hub uses.
      const parts = name.split('/');
      if (parts.length === 1) return { href: `https://hub.docker.com/_/${encodeURIComponent(name)}`, kind: 'package' };
      if (parts.length === 2 && !parts[0]!.includes('.')) {
        const encoded = path(name);
        return encoded === null ? null : { href: `https://hub.docker.com/r/${encoded}`, kind: 'package' };
      }
      return null;
    }

    default:
      // An unknown datasource gets no link rather than a guess.
      return null;
  }
}

/** npm and Packagist names contain a slash that is part of the name, not a path. */
function encodeName(name: string): string {
  return path(name) ?? encodeURIComponent(name);
}

/**
 * Fill an operator's compare-URL template, or null when it does not produce a
 * safe web address (B-6).
 *
 * The three placeholders are URL-encoded before substitution, so a query-string
 * template like octochangelog's — `?repo={repo}&from={from}&to={to}` — gets the
 * escaping it needs (`{repo}` becomes `owner%2Frepo`). The result must be an
 * http or https URL; anything else, including a `javascript:` scheme, returns
 * null and the forge's own compare link is used instead.
 */
export function fillCompareTemplate(
  template: string,
  repo: string,
  from: string,
  to: string,
): string | null {
  const href = template
    .replaceAll('{repo}', encodeURIComponent(repo))
    .replaceAll('{from}', encodeURIComponent(from))
    .replaceAll('{to}', encodeURIComponent(to));
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return href;
  } catch {
    return null;
  }
}
