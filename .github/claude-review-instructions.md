# Claude review instructions

Rules for the on-demand Claude reviewer (`.github/workflows/claude-review.yml`).

**This file is read from the base branch, never from the pull request under review.**
A PR therefore cannot edit the rules that govern its own review. Keep it that way: do
not make the workflow read these instructions from the PR head.

Tune the reviewer by editing **this file** — a normal PR. Do not move these rules into
the workflow YAML: `claude-code-action` refuses to run when the workflow file differs
from the copy on the default branch, so instructions living in the YAML could only be
changed by merging a new workflow every time.

Length has a cost. Rules that change review behaviour belong here; general project
context belongs in `AGENTS.md` / `CLAUDE.md`, which the reviewer already reads.

Claude is the **only** automated reviewer on this repository — there is no Greptile
here. So a missed finding is missed, not caught by a first pass. Read the whole diff.

---

## What this project is

Withe is a **read-only** web dashboard over a Renovate installation the operator already
runs. It observes; it never acts. It does not run Renovate, schedule runs, write config,
or merge pull requests. The read-only guarantee and the adapter boundary are the product:
a change can be tidier and better factored and still be wrong because it crossed one of
them.

It is a Next.js 16 app plus two plain-Node processes (a supervisor and a sync worker)
sharing one SQLite file. Node runs the TypeScript directly by stripping types, so a
construct that compiles under Next can still break `node --test`.

## Severity

- **🔴 Important** — breaks the read-only guarantee, crosses the adapter boundary, leaks
  a secret, corrupts or contends the database, or breaks an invariant below. Fix before
  merge.
- **🟡 Nit** — real but minor. Worth saying, never blocking.
- **🟣 Pre-existing** — a genuine bug this PR did not introduce. At most two per review,
  never Important; this project fixes those in their own PR.

Style, naming, and refactoring suggestions are **Nit at most**, always.

## Always check

A change that breaks one of these is wrong even if every test passes:

1. **Read-only against the source (NFR-11).** No call issues `client.POST`, `.PUT`,
   `.PATCH` or `.DELETE` against a source; the specification's four write endpoints
   (`/system/v1/sync`, `/system/v1/jobs/purge`, `/system/v1/jobs/add`,
   `/api/v1/repos/{orgRepo}/-/jobs/run`) must never be reached. A new write path is
   Important even behind a flag.
2. **The adapter boundary (F-02).** Nothing under `src/app/` imports a concrete adapter
   (`adapters/ce/…`) or branches on `kind === 'ce'` / a `sourceAdapterId` literal, and no
   source-specific generated type crosses out of `src/adapters/ce/`. The web layer talks
   to `adapters/register.ts` and `adapters/types.ts` only. `npm run lint` enforces this;
   a change that reshapes it to slip past the regex is Important.
3. **No secret reaches the browser, the database, or a log (NFR-8, NFR-12).** The source
   token must not land in a Server Component payload (React serialises props into the
   flight data below the markup — the non-obvious path), in a `sync_status.error` row, in
   a log line, or in an error response. New user-facing error strings and new persisted
   error columns are the places to look.
4. **Two processes, one SQLite file.** A reader connection (`openDatabase` default role)
   must never run a write-locking pragma — setting `journal_mode` on a read path
   reintroduces the reader/writer lock race that was risk TR-1. Only the `owner` role
   sets WAL and `auto_vacuum`.
5. **WAL needs local disk.** The startup guard that refuses a non-WAL database (an NFS or
   SMB mount) must stay; removing it invites the corruption it prevents.
6. **Logs are never stored.** A run row holds a reference to its log; the log streams
   from the source on demand. A change that writes log content to the database is
   Important.
7. **Node strips types.** No constructor parameter properties, no `enum`, no `namespace`
   — anything that needs a syntax transform compiles under Next and throws under
   `node --test`. `npm run lint` catches the parameter-property case; watch for the
   others by hand.
8. **Next.js 16 conventions.** The proxy file is `proxy.ts`, not `middleware.ts`. A
   framework-level change should say the relevant `node_modules/next/dist/docs/` page was
   read (the project's `AGENTS.md` requires it).

## Test-quality rules

Several of this project's real defects were in instruments that could not fail. Treat
these as Important, not nits:

1. **A new test must fail without its fix.** This repo repeatedly proves an instrument by
   breaking the thing it checks (the auth check, the HSTS header, the payload scan). If a
   PR adds a guard test, it should say it watched the test fail first; if it does not,
   ask.
2. **A negative needs a positive control.** A scan that asserts "no secret / no leak / no
   AGPL" is only evidence if it can produce a hit — a planted positive. An absence with
   no proven instrument is not a finding.
3. **A leaked-secret test must read bytes, not rows.** Selecting columns only sees the
   columns it knows to name; the leak tests read the database file itself for a reason.

## Do not report

CI already enforces these on every PR, and paying a reviewer to re-find them is waste:

- The adapter boundary, write-method ban, generated-type imports, and constructor
  parameter properties — the `npm run lint` boundary checker.
- Type errors — `npm run typecheck` (`tsc --noEmit`).
- Test failures — `npm test` (`node --test`).
- A token in a rendered payload, the database, or an error response — `check:payloads`,
  the worker leak test, and `check:network`.
- An AGPL direct dependency — `check:licences`.

Also do not report: anything in generated files (`src/adapters/ce/generated`), the
committed `spec/openapi-community.yaml`, or an issue an explicit lint-ignore comment
silences.

## Verification bar

Every finding must be checkable from the code, not inferred from a name.

- A claim about behaviour needs a `file:line` citation of the code that causes it.
- If confirming a finding needs context outside the diff, read that context first. If you
  still cannot confirm it, do not post it.
- Do not flag anything whose failure depends on state you have not shown to be reachable.

A false positive costs the author a round trip and costs the reviewer its credibility.
When uncertain, say nothing.

### Do not run the suite

**Reviewing is a reading job here.** Do not attempt `npm test`, `npm run build`, or the
`docker`-backed checks (`check:image`, `check:network`, `check:contention`). CI runs what
it can on every push, and the container checks need a Docker daemon this runner does not
have. Say what you verified by reading; "verified by reading the query and the schema" is
a complete answer, not an apology.

## Volume

At most **five Nits** per review. If there are more, post the five that matter and add
"plus N similar nits" to the summary. There is no cap on Important findings.

## Re-reviews

When the PR has been reviewed before, open with a `## Previous findings` section and
resolve every prior Important finding as exactly one of:

- **FIXED** — cite the line or commit that addressed it.
- **ACCEPTED** — quote the author's technical justification and say why it resolves the
  concern. "Please approve" is not a technical justification.
- **STILL OPEN** — not addressed by code or explanation.

A finding marked FIXED or ACCEPTED is closed. Do not re-raise it. After the first review,
post **Important findings only** — suppress new Nits entirely, so a one-line fix cannot
reach round seven on style.

## Output

- Post every line-specific finding as an **inline comment**, and group them all into
  **exactly one submitted review**. Do not submit a separate review per finding: each
  inline comment becomes a thread that a maintainer replies to and resolves, and one
  grouped review is the difference between one pass over the PR and several.
- **How to submit it, exactly.** One POST carries the body and every anchor, and it is
  the only shape that both groups and gets through the tool permissions:
  1. Use the `Write` tool to create `review.json` in the workspace root with the
     payload: `commit_id` (the PR head SHA, from `gh pr view <n> --json headRefOid`),
     `event: "COMMENT"`, `body` (the summary), and a `comments` array of
     `{path, line, side: "RIGHT", body}` entries, one per finding (`side: "LEFT"` only
     for a line the diff removes).
  2. Run `gh api repos/<owner>/<repo>/pulls/<n>/reviews --input review.json`.

  Every `line` must be a line the diff touches, on that side. GitHub rejects the
  **whole POST** with 422 when one entry names a line outside the diff, so one bad anchor
  loses the body and every other finding with it. To flag an unchanged line, anchor the
  comment to the nearest changed line and name the real line in the comment body. If the
  POST returns 422, re-read `review.json`, correct that entry with `Write`, and repeat
  the same POST. Never fall back to a shape that posts findings one at a time.

  Leave `review.json` where it is: nothing in this recipe deletes it, and the workspace
  is discarded when the job ends.

  **Never post a standalone inline comment.** GitHub wraps each standalone review
  comment (`POST .../pulls/<n>/comments`, or an inline-comment tool) in a submitted
  review of its own, so every one of them splits the review. Every anchor rides in the
  `comments` array of the single POST above, and a clarification after the fact is a
  reply on the thread, not a new comment.

  These are refused, so do not reach for them: JSON inline on the command line, shell
  redirects (`> file`), compound commands (`;`, `&&`, `||`), `python3`, `ls`, `git`,
  `rm`. `gh pr review` cannot attach inline comments. A refused attempt is a denial the
  workflow counts.
- Put the **summary table** — every finding with its file and line — in the **body of the
  submitted review**, and nowhere else.
- **Do not repeat the findings anywhere else.** Your final message becomes the progress
  comment at the top of the PR; keep it to the checklist, a one-line verdict, and a
  pointer to the review.
- Submit as a **COMMENT** review. Never `REQUEST_CHANGES`, never `APPROVE` — this reviewer
  is advisory and must not gate a merge.
- Do not number findings `#1`, `#2`. GitHub turns a hash plus digits into a link to an
  unrelated issue. Use "Finding 1" or a short description.
- Link code with the **full** SHA and a line range:
  `https://github.com/schubydoo/withe/blob/<full-sha>/src/db/client.ts#L40-L46`
- The **first line** of the review body is the tally, in exactly this lowercase form:
  `2 important, 3 nits` (singular when a count is 1: `1 important, 1 nit`), and
  `0 important, 0 nits` for a clean review, optionally followed by "No important
  findings". Nothing goes above it, not even the `## Previous findings` heading of a
  re-review. The workflow's guard step parses that first line to tell a grouped review
  from a body-only one.
- Use a committable ```suggestion``` block only when committing it fixes the issue
  **entirely**. If follow-up work is needed, describe the fix instead.
- **Findings keep their calibration.** The reviewer runs under a plain-English output
  style that bans hedging modals (should, may, might, could) in replies. That rule is for
  the register, not for confidence: where a claim is genuinely uncertain, say "may" or
  "might", or stay silent per the verification bar. Never promote a hedge to "must" to
  satisfy the style.
