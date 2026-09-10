---
default: minor
---

Show the GitHub API rate limit on the health page. When Withe reads live pull-request state, it records how much of the token's rate limit is left. A new Forge rate limit section shows that. Below 20% headroom, the page warns that a spent limit leaves merged pull requests on screen until it resets. The limit is the GitHub token's, shared with Renovate, so it is shown once for the install.
