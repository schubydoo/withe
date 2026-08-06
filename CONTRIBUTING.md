# Contributing to Withe

Thanks for looking. Withe is early — there is no release yet, and the code below does not all
exist. Where a command is not implemented, this file says so.

## Before you write code

**Open an issue first for anything larger than a bug fix.** Withe has a deliberately narrow scope,
and the "What this is not" section of the [README](README.md) lists permanent exclusions. A pull
request that runs Renovate, edits configuration, triggers runs, or merges pull requests will be
declined however good the code is. That is not a judgement of the work; those exclusions are the
product.

Bug reports and small fixes need no issue first. Send the pull request.

## Development setup

Node 24 LTS is required. `.nvmrc` and the `engines` field both state it.

```bash
git clone https://github.com/schubydoo/withe && cd withe
npm ci
cp .env.example .env          # set WITHE_CE_URL and WITHE_CE_TOKEN
npm run build:client          # generate CE types from openapi-community.yaml
npm run db:migrate            # apply migrations to ./dev.db
npm run dev                   # web, on :3000
npm run dev:worker            # worker, in a second terminal
```

You do not need a Renovate installation to work on most of Withe. The committed fixtures cover the
mapping layer, and the tests run with no network.

## Tests

```bash
npm test              # node --test, runs offline
npm run test:e2e      # Playwright against a stub CE server
npm run lint
npx tsc --noEmit
```

`npm test` must pass with no network access. If a test needs a live server, it is in the wrong
place.

Two import rules are enforced by ESLint, not by convention, because they are the boundary the whole
design rests on:

1. Nothing outside `src/adapters/ce/` imports from `src/adapters/ce/generated/`.
2. Nothing in `src/app/` imports from `src/adapters/`. Pages read the database, not adapters.

A pull request that breaks either fails the build.

## Recording a CE fixture

Fixtures are recorded Renovate CE API responses, committed to `test/fixtures/`. They let anyone
test the mapping layer without access to a Renovate server. Adding one is the most useful small
contribution available.

1. Point `.env` at your own CE server.
2. Run the recorder for the endpoint you want:
   ```bash
   npm run record:fixture -- /api/v1/orgs
   npm run record:fixture -- /api/v1/orgs/my-org/-/repos
   npm run record:fixture -- /api/v1/repos/my-org/my-repo/-/jobs
   ```
   The response is written to `test/fixtures/` as JSON.
3. **Redact it.** Replace your token, your hostnames, your organization name, and any private
   repository name. CI checks every fixture against a denylist and fails if a real value survives,
   but do not rely on that — the denylist only knows the values it was told about.
4. Add a test in the matching `*.test.ts` that asserts what the mapping layer produces from it.
5. Commit the fixture and the test together.

Useful fixtures cover states that are hard to produce on demand: a run that failed with
`artifactErrors`, a run stuck in the queue, a repository that was removed, a paginated response.

**Never commit a token, a key, or a real hostname**, in a fixture or anywhere else. If you think you
have committed one, treat it as a security report — see below.

## Pull requests

- Branch from `main`. Name it `feat/…`, `fix/…`, or `docs/…`.
- Use [Conventional Commits](https://www.conventionalcommits.org) for the commit subject:
  `fix: redact the token in job-log responses`.
- Keep the pull request to one change. Two unrelated fixes are two pull requests.
- Say what you tested. "Tests pass" is less useful than "added a fixture for a queued run; the
  triage page no longer counts it as failing".
- CI must be green: lint, types, unit tests, end-to-end tests.

Reviews come from one maintainer working evenings and weekends. Expect days, not hours. A pull
request going quiet is not a rejection; comment on it again.

## Accessibility

Every user-facing change must meet WCAG 2.1 AA: sufficient contrast, full keyboard navigation, a
sensible focus order, and **status never conveyed by colour alone**. A repository that is failing
says so in text, not only in red.

## Security

Do not open a public issue for a security problem. Use
[private advisories](https://github.com/schubydoo/withe/security/advisories/new). See
[SECURITY.md](SECURITY.md).

## Conduct

The [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere in this project.
