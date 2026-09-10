---
default: minor
---

Read live pull-request state from GitHub. A merged or closed Renovate pull request now leaves the dashboard within one sync. Before, Withe read pending updates only from the newest Renovate job log, which is a snapshot. A merge stayed on screen until Renovate ran again, up to about one hour on an hourly runner.

To turn this on, set WITHE_GITHUB_TOKEN. Each sync, Withe reads the pull-request numbers from the log again. It confirms each pull request is Renovate's by its branch prefix and its author. It marks the merged and closed ones. Withe never edits your renovate.json. Withe never stores the token. If the forge is unreachable, Withe keeps the log's state.
