# Contributing to Withe

Thanks for looking. Withe is a small project maintained in spare time; bug reports and pull
requests are welcome.

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
cp .env.example .env                       # then set WITHE_CE_URL and WITHE_CE_TOKEN
npm run build:client                       # generate the CE types from the OpenAPI spec
node --env-file=.env src/worker/main.ts    # worker: creates and migrates the DB, then syncs
npm run dev                                # web, on :3000, in a second terminal
```

The worker applies migrations on startup, so there is no separate migrate step. Run it first — it
creates and migrates the database — then start the web in a second terminal. `next dev` reads `.env`
automatically; the worker reads the ambient environment, so it is started with `--env-file`.

Install the pre-commit hooks once — they run the same type-check, lint, changeset and test gates CI
does, before the code leaves your machine:

```bash
uvx pre-commit install --install-hooks
```

You do not need a Renovate installation to work on most of Withe. The committed fixtures cover the
mapping layer, and the tests run with no network.

## Tests

```bash
npm test              # node --test, runs offline
npm run e2e           # end-to-end flows against a stub CE server
npm run lint          # import-boundary checks (scripts/check-boundaries.ts)
npx tsc --noEmit
```

`npm test` must pass with no network access. If a test needs a live server, it is in the wrong
place.

The import boundary is enforced by a lint check (`npm run lint`, `scripts/check-boundaries.ts`), not
by convention, because it is what the whole design rests on. Two of its rules matter most:

1. Nothing outside `src/adapters/ce/` imports from `src/adapters/ce/generated/`.
2. Nothing in `src/app/` imports from `src/adapters/`. Pages read the database, not adapters.

A pull request that breaks either fails the build.

## Recording a CE fixture

Fixtures are recorded Renovate CE API responses, committed to `test/fixtures/ce/`. They let anyone
test the mapping layer without access to a Renovate server. Adding one is the most useful small
contribution available.

1. Capture the raw responses from your own CE server to `/tmp/rec/`, one file per endpoint. The
   redactor expects these names:
   ```
   /tmp/rec/orgs.json         # GET /api/v1/orgs
   /tmp/rec/repos.json        # GET /api/v1/orgs/<org>/-/repos
   /tmp/rec/jobs-page1.json   # GET /api/v1/repos/<org>/<repo>/-/jobs
   /tmp/rec/jobs-page2.json   # the next page, if any
   /tmp/rec/job.ndjson        # the NDJSON job log
   ```
2. Redact them into committable fixtures:
   ```bash
   python3 scripts/redact-fixtures.py    # reads /tmp/rec, writes test/fixtures/ce/
   ```
   It replaces your organization and repository names, IP addresses, job ids, and commit hashes with
   stable synthetic values.
3. **Check the result.** CI checks every fixture against a denylist and fails if a real value
   survives, but do not rely on that — the denylist only knows the values it was told about.
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

## Changesets

Any user-visible change ships a **changeset** — a small fragment in `.changeset/` that drives both
the version bump and the changelog. Create `.changeset/<slug>.md` (or run `knope document-change`)
with YAML front matter and a **single-line** body:

```markdown
---
default: minor
---

List lock-file refreshes in their own section instead of only counting them
```

- `default:` is one of `major` (breaking), `minor` (feature → Features), `patch` (fix → Fixes),
  `security`, or `perf`.
- The body must be **exactly one line**. knope renders a second line as a `#### heading` mid-list,
  which corrupts the release notes. Fold all detail into that one sentence.
- **Never add a `README.md` or any non-fragment `.md` to `.changeset/`** — knope parses every `.md`
  there and a file without front matter fails the release.
- `CHANGELOG.md` is generated from these fragments; do not hand-edit it. Internal-only pull requests
  (CI, refactor, tests) skip the changeset.

Releases run through [knope](https://knope.tech): merging a `chore: prepare release` pull request
tags `v*` and builds the image.

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
