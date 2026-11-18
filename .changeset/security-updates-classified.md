---
default: patch
---
A Renovate security update now shows as `security`, and the security filter on `/updates` finds it. Renovate's branch summary does not carry the vulnerability flag. Withe now reads the `[SECURITY]` suffix that Renovate adds to each vulnerability fix title. Before this change, a security fix showed as a plain `patch` or `minor` update.
