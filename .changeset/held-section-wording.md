---
default: patch
---

Rename the dashboard's "Held for your review" section to "Major & 0.x updates" and mark each row's pull-request state, so a read-only operator who runs no Dependency Dashboard is not told to review a pull request that may not exist. A held row with no pull request now names the upstream changelog as the one review Withe can offer, and a note states that a no-pull-request row is not stuck
