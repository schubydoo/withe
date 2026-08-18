import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dependencyLink, fillCompareTemplate, pullRequestUrl, repoUrl, webBaseFrom } from './links.ts';

test('a browsable base is derived from the API endpoint, not assumed', () => {
  assert.equal(webBaseFrom('github', 'https://api.github.com/'), 'https://github.com');
  // Enterprise Server serves the API under the same host as the site.
  assert.equal(webBaseFrom('github', 'https://ghe.example.com/api/v3/'), 'https://ghe.example.com');
  assert.equal(webBaseFrom('gitlab', 'https://gitlab.example.com/api/v4/'), 'https://gitlab.example.com');
  assert.equal(webBaseFrom('github', 'https://ghe.example.com:8443/api/v3/'), 'https://ghe.example.com:8443');
});

test('an unusable endpoint yields nothing rather than a guess', () => {
  assert.equal(webBaseFrom('github', null), null);
  assert.equal(webBaseFrom('github', 'not a url'), null);
  assert.equal(webBaseFrom(null, ''), null);
});

test('repository and pull request links follow the forge', () => {
  assert.equal(repoUrl('https://github.com', 'acme/widget'), 'https://github.com/acme/widget');
  assert.equal(
    pullRequestUrl('https://github.com', 'github', 'acme/widget', 1199),
    'https://github.com/acme/widget/pull/1199',
  );
  // GitLab calls them merge requests and routes them differently.
  assert.equal(
    pullRequestUrl('https://gitlab.example.com', 'gitlab', 'acme/widget', 7),
    'https://gitlab.example.com/acme/widget/-/merge_requests/7',
  );
});

test('a missing forge or number produces no link rather than a broken one', () => {
  assert.equal(repoUrl(null, 'acme/widget'), null);
  assert.equal(repoUrl('https://github.com', 'no-slash'), null);
  assert.equal(pullRequestUrl('https://github.com', 'github', 'acme/widget', null), null);
  assert.equal(pullRequestUrl('https://github.com', 'github', 'acme/widget', 0), null);
  assert.equal(pullRequestUrl(null, 'github', 'acme/widget', 5), null);
});

test('a version change on a forge datasource compares the two versions', () => {
  // The operator's example, from the running instance.
  assert.deepEqual(
    dependencyLink('github-tags', 'anthropics/claude-code-action', 'v1.0.185', 'v1.0.186'),
    {
      href: 'https://github.com/anthropics/claude-code-action/compare/v1.0.185...v1.0.186',
      kind: 'compare',
    },
  );
  assert.deepEqual(dependencyLink('github-releases', 'astral-sh/uv', '0.12.1', '0.12.2'), {
    href: 'https://github.com/astral-sh/uv/compare/0.12.1...0.12.2',
    kind: 'compare',
  });
  assert.deepEqual(dependencyLink('gitlab-tags', 'acme/tool', '1.0.0', '2.0.0'), {
    href: 'https://gitlab.com/acme/tool/-/compare/1.0.0...2.0.0',
    kind: 'compare',
  });
});

test('without two versions there is nothing to compare, so it links the repository', () => {
  assert.deepEqual(dependencyLink('github-tags', 'astral-sh/uv', null, null), {
    href: 'https://github.com/astral-sh/uv',
    kind: 'package',
  });
  assert.deepEqual(dependencyLink('github-tags', 'astral-sh/uv', '1.0.0', '1.0.0'), {
    href: 'https://github.com/astral-sh/uv',
    kind: 'package',
  });
});

test('registry datasources link to the package page', () => {
  assert.equal(dependencyLink('npm', 'typescript-eslint', '8.65.0', '8.66.0')?.href,
    'https://www.npmjs.com/package/typescript-eslint');
  // A scoped npm name carries a slash that is part of the name.
  assert.equal(dependencyLink('npm', '@tabler/icons', '1', '2')?.href,
    'https://www.npmjs.com/package/%40tabler/icons');
  assert.equal(dependencyLink('pypi', 'pyte', '0.8.1', '0.8.2')?.href, 'https://pypi.org/project/pyte/');
  assert.equal(dependencyLink('crate', 'clap', '4.0.0', '4.1.0')?.href, 'https://crates.io/crates/clap');
  assert.equal(dependencyLink('go', 'github.com/spf13/cobra', 'v1', 'v2')?.href,
    'https://pkg.go.dev/github.com/spf13/cobra');
  assert.equal(dependencyLink('rubygems', 'rails', '7', '8')?.href, 'https://rubygems.org/gems/rails');
});

test('docker links only where the registry can be inferred', () => {
  assert.equal(dependencyLink('docker', 'nginx', '1', '2')?.href, 'https://hub.docker.com/_/nginx');
  assert.equal(dependencyLink('docker', 'library/nginx', '1', '2')?.href,
    'https://hub.docker.com/r/library/nginx');
  // A registry host in the name means Docker Hub is the wrong answer.
  assert.equal(dependencyLink('docker', 'ghcr.io/mend/renovate-ce', '15', '16'), null);
});

test('an unknown datasource gets no link rather than a guess', () => {
  assert.equal(dependencyLink('something-new', 'thing', '1', '2'), null);
  assert.equal(dependencyLink(null, 'thing', '1', '2'), null);
  assert.equal(dependencyLink('npm', null, '1', '2'), null);
  assert.equal(dependencyLink('npm', '   ', '1', '2'), null);
  assert.equal(dependencyLink('github-tags', 'no-slash', '1', '2'), null);
});

test('nothing from the source is placed in a URL unescaped', () => {
  // A version or name is a value the source chose, and a page renders the
  // result. Neither may close the attribute or change the path.
  const link = dependencyLink('github-tags', 'acme/tool', 'v1"onmouseover="x', 'v2/../../../etc');
  assert.ok(link);
  assert.ok(!link.href.includes('"'), link.href);
  assert.ok(!link.href.includes('../'), link.href);

  const repo = repoUrl('https://github.com', 'acme/we ird');
  assert.equal(repo, 'https://github.com/acme/we%20ird');

  // Refused outright rather than sanitised — see the next test.
  assert.equal(pullRequestUrl('https://github.com', 'github', 'acme/../../evil', 5), null);
});

test('a path that would resolve elsewhere is refused outright', () => {
  // encodeURIComponent leaves a dot alone, so `..` survives it and the browser
  // resolves the result to a different repository.
  assert.equal(repoUrl('https://github.com', 'acme/../../evil'), null);
  assert.equal(repoUrl('https://github.com', 'acme//widget'), null);
  assert.equal(pullRequestUrl('https://github.com', 'github', 'acme/../evil', 5), null);
  assert.equal(dependencyLink('github-tags', 'acme/../evil', '1', '2'), null);
  assert.equal(dependencyLink('go', 'github.com/../evil', 'v1', 'v2'), null);

  // And the ordinary case still works.
  assert.equal(repoUrl('https://github.com', 'acme/widget'), 'https://github.com/acme/widget');
});

const OCTO = 'https://octochangelog.com/compare?repo={repo}&from={from}&to={to}';

test('a compare-url template redirects the compare links, URL-encoded', () => {
  assert.deepEqual(dependencyLink('github-tags', 'renovatebot/renovate', '1.0.0', '2.0.0', OCTO), {
    href: 'https://octochangelog.com/compare?repo=renovatebot%2Frenovate&from=1.0.0&to=2.0.0',
    kind: 'compare',
  });
  assert.deepEqual(dependencyLink('gitlab-tags', 'acme/tool', '1.0.0', '2.0.0', OCTO), {
    href: 'https://octochangelog.com/compare?repo=acme%2Ftool&from=1.0.0&to=2.0.0',
    kind: 'compare',
  });
});

test('the template touches only compares, not package links', () => {
  // No version range: a package link, left alone.
  assert.equal(
    dependencyLink('github-tags', 'astral-sh/uv', null, null, OCTO)?.href,
    'https://github.com/astral-sh/uv',
  );
  // A non-forge datasource has no compare, so the template does not apply.
  assert.equal(
    dependencyLink('npm', 'typescript', '5.0.0', '5.1.0', OCTO)?.href,
    'https://www.npmjs.com/package/typescript',
  );
});

test('a broken template falls back to the forge compare, never a bad href', () => {
  assert.equal(fillCompareTemplate('not a url', 'a/b', '1', '2'), null);
  assert.equal(fillCompareTemplate('javascript:alert(1)', 'a/b', '1', '2'), null);
  assert.equal(
    dependencyLink('github-tags', 'a/b', '1.0.0', '2.0.0', 'not a url')?.href,
    'https://github.com/a/b/compare/1.0.0...2.0.0',
  );
});

test('fillCompareTemplate encodes each placeholder', () => {
  assert.equal(
    fillCompareTemplate('https://x.example/{repo}/{from}/{to}', 'a/b', 'v1.0', 'v2.0'),
    'https://x.example/a%2Fb/v1.0/v2.0',
  );
});
