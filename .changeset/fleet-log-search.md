---
default: minor
---

Withe can now search every repository's log problems on one page, at `/problems`, instead of opening runs one at a time to find a fatal. As it reads each log, Withe keeps that run's warn, error, and fatal lines. Whole logs are still never stored, and the page says so, because an empty result means that no problem line matched rather than that nothing happened anywhere. The search matches any part of a line and filters by level, where a level means that level and worse. A line one run wrote many times is one row with a count, a line longer than 500 characters is stored to its first 500, a line costs about 108 bytes, and `WITHE_RETENTION_DAYS` deletes these lines with the run they came from. Withe indexes the log it reads at each sync, which is each repository's newest finished run, so the index covers what Withe watched rather than reaching back over history.
