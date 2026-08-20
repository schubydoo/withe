# Configuration

Two shapes, one result. Flat environment variables describe one source; a mounted YAML file
describes many. Both produce the same internal configuration, so adding a second source later needs
no breaking change.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `WITHE_CE_URL` | — | Renovate CE server base URL |
| `WITHE_CE_TOKEN` | — | The `MEND_RNV_API_SERVER_SECRET` value |
| `WITHE_CE_ORGS` | discovered | Comma-separated organizations, when discovery is not available |
| `WITHE_SYNC_INTERVAL_SECONDS` | `300` | How often Withe re-reads from the source |
| `WITHE_STALLED_AFTER_DAYS` | `7` | When a repository with no successful run is called stalled |
| `WITHE_RETENTION_DAYS` | unset | Prune run history older than this; unset keeps everything |
| `WITHE_COMPARE_URL` | forge compare | Send a dependency's compare link to your own template instead of the forge — see [Compare links](#compare-links) |
| `WITHE_AUTH_USER` / `WITHE_AUTH_PASS` | unset | Enable HTTP basic authentication — see [Exposure](exposure.md) |
| `WITHE_TLS_CERT` / `WITHE_TLS_KEY` | unset | Enable the TLS proxy — see [Exposure](exposure.md) |
| `WITHE_DB_PATH` | `/data/withe.db` | Database location |
| `WITHE_CONFIG` | `/data/withe.yaml` | Config file path, used when the file exists |
| `WITHE_BIND` | `127.0.0.1` | Listen address. Inside a container Withe binds `0.0.0.0`; containment comes from the published address |
| `WITHE_PORT` | `3000` | Listen port |

## Compare links

By default a dependency's compare link opens the forge's own two-version diff,
such as `github.com/owner/repo/compare/v1...v2`. Set `WITHE_COMPARE_URL` to send
it elsewhere — for example a rendered changelog across the range at octochangelog:

```
WITHE_COMPARE_URL=https://octochangelog.com/compare?repo={repo}&from={from}&to={to}
```

The placeholders `{repo}`, `{from}`, and `{to}` are filled URL-encoded, so a
query-string template escapes correctly (`{repo}` becomes `owner%2Frepo`). That
encoding suits a query string; a path-style template that needs a literal slash
in the repository path is not supported, because `{repo}` is always escaped.

The template replaces the compare links for **every** forge — both GitHub and
GitLab sources with two known versions (package links stay as they are). It
carries no way to say which forge a link is for, so a service that understands
only one — octochangelog resolves GitHub repositories only — will turn the
others' compare links into ones it cannot open. Use a forge-specific service
only where every dependency lives on that forge.

A template that names none of the placeholders, or that does not form an `http`
or `https` address, is ignored with a startup warning and the forge link is used.

## Config file (many sources)

When `WITHE_CONFIG` points at a file that exists, the file wins and the flat `WITHE_CE_*` variables
are ignored with a startup warning.

```yaml
sources:
  - id: home-ce
    kind: ce
    url: https://renovate.example.lan
    tokenEnv: HOME_CE_TOKEN      # names an environment variable, never the secret itself
  - id: cron-logs
    kind: jsonlog
    path: /logs/renovate         # a directory of Renovate JSON Lines logs, mounted read-only
```

`tokenEnv` names a variable rather than holding the secret, so the file is safe to commit or paste
into a forum post when asking for help.

## Source kinds

### `ce` — a self-hosted Renovate server

Reads the server's API. Needs `url` and `tokenEnv`.

### `jsonlog` — a directory of run logs

For the operator who runs plain `renovate/renovate` — a cron container, a CI job, or by hand — and
has no server API to ask. Point Renovate's `RENOVATE_LOG_FILE` (with
`RENOVATE_LOG_FILE_LEVEL=debug`) into a directory and mount that directory into Withe read-only;
`path` names where it is mounted. Nothing about how Renovate runs changes.

- Files ending `.log`, `.jsonl`, or `.ndjson` are read, including up to three directory levels down,
  so an unzipped CI artifact works as dropped.
- New and appended files are picked up on the next sync cycle; no restart, no file watcher.
- One file may hold many runs (a runner appending across invocations), or one run per file (a CI
  artifact per workflow run). Both work, and a file copied by hand next to the live one does not
  double its runs.
- A file that is not a Renovate log is skipped with a warning on the health page, never a crash.
- Withe never writes to, moves, or deletes a log file. The files are yours; retention is yours too.
