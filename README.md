# Withe

**Withe is a dashboard for the Renovate you already run — no operator, no migration, nothing to replace.**

You point it at a Renovate installation that is already working. It reads. It changes nothing.

---

## Status: not usable yet

There is no release, no container image, and no code in this repository beyond these documents.
Nothing below works today. This section is removed when the first release exists.

---

## The problem

Renovate tells you what it did, one repository at a time. A run that failed three days ago on one
of forty repositories looks exactly like a run that did not happen. Finding it means reading
container logs or opening forty Dependency Dashboard issues.

Withe answers, on one page: **which repositories are broken, and since when.**

## What Withe shows

- **Preflight.** Renovate CE ships its API switched off. Withe names the exact environment
  variables that are missing and gives you a block to paste into your Compose file.
- **Repository inventory.** Every organization and repository Renovate knows about, with its
  enablement state, install status, and last run.
- **Failure triage.** The landing page. Repositories with failing runs, ordered by how long they
  have been failing, with the error attached.
- **Run history.** Every run for a repository — when it was queued, when it started, how long it
  took, and how it ended.
- **Log viewer.** The full JSON-Lines log for any run, read through Renovate's documented log
  endpoint. No log scraping off a container.

Later releases read plain Renovate runs from JSON log files, so a Renovate on cron or a GitHub
Action works too, and then read open pull requests from your forge.

## What this is not

Every item here is a permanent exclusion, not a feature that is coming.

- **Withe does not run Renovate.** It observes one that is already running. With no Renovate, it
  shows nothing.
- **Withe does not schedule runs.**
- **Withe does not edit or write back Renovate configuration.** Your `renovate.json` is never
  touched, and you never add anything to it to make Withe work.
- **Withe does not merge pull requests.**
- **Withe does not trigger runs.** Renovate CE offers an endpoint for it. Withe does not call it.
- **Withe has no user accounts, roles, or permissions.** It is one operator looking at their own
  installation. Optional HTTP basic authentication is the whole of it.

Withe is read-only against Renovate by design. Everything above is what "non-invasive" means in
practice.

## Requirements

- A working Renovate installation.
- For the first release, that means Renovate Community Edition with its HTTP API enabled. The
  preflight page tells you which variables to set.
- Docker, or anywhere else you can run a container.

## Installation

No release yet. Installation will be one container and one volume.

## Usage

No release yet.

## Storage and retention

Withe keeps run history in one SQLite file on its volume. It never stores log content — a run row
holds a reference to the log, and the log is streamed from Renovate on demand.

A run row costs about **150 bytes**, so the database grows by roughly **1 MB per 7,000 runs**. One
run is one Renovate job for one repository. A fleet of 8 repositories on Renovate's hourly schedule
records about 190 runs a day, or close to **10 MB a year**.

By default Withe keeps every run. To cap the history, set `WITHE_RETENTION_DAYS` to a number of
days. Withe then deletes runs older than that at the end of each sync and returns the freed space to
the disk. Repositories, pending updates and forge links are never pruned.

## Relationship to Mend and Renovate

Withe is an independent project. **It is not affiliated with, endorsed by, or supported by Mend.io,
and it is not part of Renovate.** Renovate and Renovate Community Edition are Mend's; your use of
them stays subject to Mend's terms, whatever Withe does.

Two rules Withe holds itself to:

- **It uses only Renovate CE's documented public API.** No private endpoint, no undocumented
  behavior, no scraping around the API.
- **You run Withe against your own Renovate installation.** It is not built to be operated as a
  hosted service for other people, and it will not be.

Report a bug against Withe to this repository, not to Mend.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through
[private advisories](https://github.com/schubydoo/withe/security/advisories/new), not public
issues — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
