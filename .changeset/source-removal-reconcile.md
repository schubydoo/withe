---
default: patch
---

A source you delete from the configuration now leaves the dashboard. Until now Withe only ever cleaned up inside a source it still synced, so a deleted source kept its repositories, pending updates, runs and log problems on every page for good, and the health page reported it as a source that had stopped syncing. Each sync cycle now compares the stored sources against the configured ones and marks the ones that left, together with their repositories. Their pending updates are deleted, because nothing refreshes them again. Their runs, completed updates and problem lines stay, hidden from every page, and age out under `WITHE_RETENTION_DAYS` like any other run history, so a typo in a source id does not cost you a fleet's history: add the source back under the same id and it returns whole on the next sync.
