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
| `WITHE_AUTH_USER` / `WITHE_AUTH_PASS` | unset | Enable HTTP basic authentication — see [Exposure](exposure.md) |
| `WITHE_TLS_CERT` / `WITHE_TLS_KEY` | unset | Enable the TLS proxy — see [Exposure](exposure.md) |
| `WITHE_DB_PATH` | `/data/withe.db` | Database location |
| `WITHE_CONFIG` | `/data/withe.yaml` | Config file path, used when the file exists |
| `WITHE_BIND` | `127.0.0.1` | Listen address. Inside a container Withe binds `0.0.0.0`; containment comes from the published address |
| `WITHE_PORT` | `3000` | Listen port |

## Config file (many sources)

When `WITHE_CONFIG` points at a file that exists, the file wins and the flat `WITHE_CE_*` variables
are ignored with a startup warning.

```yaml
sources:
  - id: home-ce
    kind: ce
    url: https://renovate.example.lan
    tokenEnv: HOME_CE_TOKEN      # names an environment variable, never the secret itself
```

`tokenEnv` names a variable rather than holding the secret, so the file is safe to commit or paste
into a forum post when asking for help.
