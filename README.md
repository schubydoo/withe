# Withe

**Withe is a dashboard for the Renovate you already run — no operator, no migration, nothing to replace.**

You point it at a Renovate installation that is already working. It reads. It changes nothing.

---

## Status: not released yet

Withe is built and runs — the container image below builds from this repository and the dashboard
works. What does not exist yet is a **tagged release and a published image**: `ghcr.io/schubydoo/withe`
is not pushed until v1.0. Until then, build the image yourself (see [Installation](#installation)).
This section is removed when the first release exists.

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

![The failure-triage landing page: a banner when data is stale, then the repositories that are
failing ordered by how long they have been failing, each with its error, above the pending
updates.](docs/images/failure-triage.png)

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
- A current browser. The interface is tested on Chromium, Firefox, and WebKit. WebKit is
  Playwright's Safari engine — a stand-in for Safari, not Safari itself, so Safari is expected to
  work but is not part of the automated suite.

## Installation

One container, one volume, one published port. Build the image from this repository until a release
is published:

```bash
docker build -t withe .
```

### Run it

```bash
docker run -d \
  --name withe \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /app/.next/cache \
  -p 127.0.0.1:8080:3000 \
  -v withe-data:/data \
  -e WITHE_CE_URL=https://renovate.example.lan \
  -e WITHE_CE_TOKEN=your-server-secret \
  withe
```

Open `http://127.0.0.1:8080`. If Renovate's API is not switched on, the preflight page names the
exact variables to set on the Renovate side.

Every flag earns its place:

- **`-p 127.0.0.1:8080:3000`** publishes to host loopback only. This is the real containment
  control: it is what keeps Withe off your network. Publishing as `-p 8080:3000` instead puts the
  dashboard on your LAN with no password — do not, unless you have read [Exposure](#exposure) below.
- **`--restart unless-stopped`** is required, not optional. The supervisor exits after three
  consecutive start failures so the restart policy takes over; with no policy the container simply
  stops, and you are left with the dead container the design exists to avoid.
- **`--read-only` with the two `tmpfs` mounts** runs the root filesystem read-only. Withe writes
  only to `/data` (the volume), to `/tmp`, and to the Next.js cache; the mounts cover the last two.

### Or with Docker Compose

```yaml
services:
  withe:
    image: withe          # or build: . from this repository
    container_name: withe
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
      - /app/.next/cache
    ports:
      - "127.0.0.1:8080:3000"   # host loopback only — see Exposure
    volumes:
      - withe-data:/data
    environment:
      WITHE_CE_URL: https://renovate.example.lan
      WITHE_CE_TOKEN: ${WITHE_CE_TOKEN}   # from a .env file or your secret store
      # WITHE_AUTH_USER and WITHE_AUTH_PASS to require a login — see Exposure
      # WITHE_RETENTION_DAYS to cap run history — see Storage and retention

volumes:
  withe-data:
```

The full set of variables — sync interval, TLS, a multi-source config file — is listed on the
preflight page and in the configuration reference.

## Exposure

**Withe must not be published to the internet without authentication and TLS in front of it.** It is
read-only against Renovate, but it shows every repository, run and log your Renovate can see, and by
default it has no password.

Two dials, both off by default:

- **Basic authentication.** Set `WITHE_AUTH_USER` and `WITHE_AUTH_PASS`, and every page and route
  requires that credential. It is a floor, not a gate: use it behind something, not as the only
  control.
- **TLS.** Set `WITHE_TLS_CERT` and `WITHE_TLS_KEY` to two mounted certificate files, and Withe
  terminates HTTPS itself. It neither obtains nor renews certificates — that is your reverse proxy
  or ACME client.

Most operators running Renovate CE already run something better than basic auth. Put Withe behind
it: **[Authelia](https://www.authelia.com/)**, **[Authentik](https://goauthentik.io/)**, or
**[Tailscale](https://tailscale.com/)** so it is only reachable on your tailnet. When Withe detects
it is reachable beyond loopback with no credentials set, it prints a warning at startup and shows a
banner on every page.

## Usage

Once it is running and Renovate's API is on, Withe syncs on its own every five minutes and needs no
further attention. The landing page is the failure-triage view above: it leads with what is broken.
`/health` shows the last sync per source and links `/api/health`, which a container healthcheck (or
your own monitoring) can poll — it answers `200` only while the data is fresh.

## Storage and retention

Withe keeps run history in one SQLite file on its volume. It never stores log content — a run row
holds a reference to the log, and the log is streamed from Renovate on demand.

A run row costs about **150 bytes**, so the database grows by roughly **1 MB per 7,000 runs**. One
run is one Renovate job for one repository. A fleet of 8 repositories on Renovate's hourly schedule
records about 190 runs a day, or close to **10 MB a year**.

By default Withe keeps every run. To cap the history, set `WITHE_RETENTION_DAYS` to a number of
days. Withe then deletes runs older than that at the end of each sync and returns the freed space to
the disk. Repositories, pending updates and forge links are never pruned.

### Put the volume on local disk

Use a Docker named volume or a local disk path. **Do not point the volume at an NFS or SMB mount.**
SQLite runs in write-ahead-logging mode, which needs a memory-mapped `-shm` file that network
filesystems do not provide; two processes sharing the database over NFS is the surest way to corrupt
it. Withe checks this at startup and refuses to run rather than risk the data, naming the cause.

### Backing up

The database is written live by two processes, so **do not `cp` the `.db` file** — a copy taken
mid-write is a torn, possibly unusable database, and it misses the `-wal` file beside it. Use
SQLite's own consistent copy instead:

```bash
docker exec withe sh -c 'sqlite3 /data/withe.db ".backup /data/withe-backup.db"'
```

Then copy `withe-backup.db` off the volume. It is safe to take while Withe is running. Withe holds
nothing you cannot re-read from Renovate, so this protects your run history, not irreplaceable data.

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
