# Storage & export

Withe keeps run history in one SQLite file on its volume. It never stores log content — a run row
holds a reference to the log, and the log is streamed from Renovate on demand.

## Growth and retention

A run row costs about **150 bytes**, so the database grows by roughly **1 MB per 7,000 runs**. One
run is one Renovate job for one repository. A fleet of 8 repositories on Renovate's hourly schedule
records about 190 runs a day, or close to **10 MB a year**.

By default Withe keeps every run. Set `WITHE_RETENTION_DAYS` to a number of days to cap the history;
Withe then deletes older runs at the end of each sync and returns the freed space to the disk.
Retention only touches runs the source itself no longer reports — a run the server still lists (or
whose log file still sits in a mounted directory) would only be re-ingested on the next sync, so it
stays until the source drops it. Repositories, pending updates, and forge links are never pruned.

## File-backed sources: your files, your retention

For a `jsonlog` source the log files are the source record, not a cache, so the rule is different
and simpler:

- **Withe never deletes, moves, or writes a log file.** It did not create them, and a build check
  enforces that no adapter can gain a filesystem write. Rotate or delete logs with the tools that
  made them — `logrotate`, your CI's artifact retention, or by hand.
- **The files govern what Withe knows.** Every sync re-reads the directory. Delete a file and its
  runs keep their history rows (like a server-pruned run, the log link goes grey); add or append a
  file and its runs appear on the next sync.
- **`WITHE_RETENTION_DAYS` takes effect only after the file is gone.** Retention skips runs the
  source still reports, so a run whose file remains is kept — pruning it would only re-ingest it on
  the next sync. Deleting the file is the operator's statement that the history can start aging out.
  A sync that could not read the directory or a file releases nothing: only a fully read directory
  counts as the source's whole word.

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
