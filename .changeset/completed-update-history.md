---
default: minor
---

Withe now keeps a history of the updates Renovate finished, not only the pending ones. Until now a merged pull request left the dashboard at the next sync and nothing recorded that it ever landed. A new `completed_update` table stores the outcome as soon as the forge reports it, so the record survives the sync that drops the pending row. Each entry names the repository, the dependency, and the old and new versions. It also names the update type, the pull-request number, whether it merged or closed, and the date it reached that state. The store holds this metadata only, and `WITHE_RETENTION_DAYS` prunes the history on the same schedule as run history.
