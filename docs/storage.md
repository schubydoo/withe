# Storage & export

Withe keeps run history in one SQLite file on its volume. It never stores log content — a run row
holds a reference to the log, and the log is streamed from Renovate on demand.

## Growth and retention

A run row costs about **150 bytes**, so the database grows by roughly **1 MB per 7,000 runs**. One
run is one Renovate job for one repository. A fleet of 8 repositories on Renovate's hourly schedule
records about 190 runs a day, or close to **10 MB a year**.

By default Withe keeps every run. Set `WITHE_RETENTION_DAYS` to a number of days to cap the history;
Withe then deletes older runs at the end of each sync and returns the freed space to the disk.
Repositories, pending updates, and forge links are never pruned.

## Put the volume on local disk

Use a Docker named volume or a local disk path. **Do not point the volume at an NFS or SMB mount.**
SQLite runs in write-ahead-logging mode, which needs a memory-mapped `-shm` file that network
filesystems do not provide. Withe checks this at startup and refuses to run rather than risk the data.

## Backing up

The database is written live by two processes, so **do not `cp` the `.db` file** — a copy taken
mid-write is torn, and it misses the `-wal` file beside it. Use SQLite's own consistent copy:

```bash
docker exec withe sh -c 'sqlite3 /data/withe.db ".backup /data/withe-backup.db"'
```

Then copy `withe-backup.db` off the volume. It is safe to take while Withe is running.

## Taking your data out

Two export forms, both behind the same login as the dashboard, and both work even if the sync worker
has stopped:

```bash
# Every table as one JSON document
curl -u user:pass http://127.0.0.1:8080/api/export -o withe-export.json

# A consistent SQLite copy (safe to take while Withe is syncing)
curl -u user:pass 'http://127.0.0.1:8080/api/export?format=sqlite' -o withe-export.db
```

## Teardown

To remove Withe completely, stop the container and delete its volume. Nothing lives outside it.

```bash
docker rm -f withe
docker volume rm withe-data
```
