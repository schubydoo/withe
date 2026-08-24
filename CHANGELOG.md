## 1.3.0 (2026-08-24)

### Features

- Add WITHE_ACKNOWLEDGE_EXPOSURE to silence the no-password exposure warning for a deployment that controls access in front of Withe (a reverse proxy, an identity-aware gateway, a tailnet). It hides the startup line and the banner without setting credentials Withe would then also check; the warning itself keeps naming the real fixes rather than advertising the switch that hides it ([#64](https://github.com/schubydoo/withe/pull/64))

### Fixes

- Rename the dashboard's "Held for your review" section to "Major & 0.x updates" and mark each row's pull-request state, so a read-only operator who runs no Dependency Dashboard is not told to review a pull request that may not exist. A held row with no pull request now names the upstream changelog as the one review Withe can offer, and a note states that a no-pull-request row is not stuck ([#62](https://github.com/schubydoo/withe/pull/62))

## 1.2.0 (2026-08-21)

### Features

- Read plain Renovate from a mounted directory of JSON Lines logs — no server API needed ([#52](https://github.com/schubydoo/withe/pull/52))
- Name the manifests a lock-file refresh covers on the dashboard, not only count them ([#46](https://github.com/schubydoo/withe/pull/46))
- Show which source contributed each repository and run, filter by it, and group a repository seen by two sources into one row ([#53](https://github.com/schubydoo/withe/pull/53))
- Show the Renovate server's queue depth, oldest waiting job, version and boot time on the health page ([#51](https://github.com/schubydoo/withe/pull/51))
- Search and filter the repository list by name and state, with the filter kept in the URL ([#49](https://github.com/schubydoo/withe/pull/49))

### Fixes

- Group a repository two sources both watch into one entry on the dashboard instead of listing it twice ([#55](https://github.com/schubydoo/withe/pull/55))
- Call the health page's sources "Renovate sources", not "server", so a log-directory-only install is not told it has a server ([#56](https://github.com/schubydoo/withe/pull/56))
- Say a log-directory source has no server to query on the health page, instead of naming a system-API setting it does not have ([#54](https://github.com/schubydoo/withe/pull/54))
- Give the lock-file refreshes table fixed column widths so a long branch name or a workspace's many manifest paths wraps in its column instead of stretching the table ([#58](https://github.com/schubydoo/withe/pull/58))
- List a lock-file refresh's manifest paths one per line, with an expander past the first three, so a workspace's many paths read cleanly instead of wrapping mid-path ([#59](https://github.com/schubydoo/withe/pull/59))
- Drop a removed repository's pending updates instead of listing them forever ([#47](https://github.com/schubydoo/withe/pull/47))

## 1.1.0 (2026-08-18)

### Features

- Download a run's whole log as a named file from the run page ([#28](https://github.com/schubydoo/withe/pull/28))
- Add a dark theme that follows the operating system, with a manual light or dark override ([#30](https://github.com/schubydoo/withe/pull/30))
- Estimate and live-count-down to the next Renovate run on the dashboard ([#35](https://github.com/schubydoo/withe/pull/35))
- Let the operator point the dependency compare links at a chosen URL template ([#37](https://github.com/schubydoo/withe/pull/37))
- Show data staleness on every page and keep it live, from one threshold ([#33](https://github.com/schubydoo/withe/pull/33))

### Fixes

- Center the exposure banner's text in the page column instead of against the window edge ([#28](https://github.com/schubydoo/withe/pull/28))
- Make the health page say it is about reaching Renovate, not the repositories Renovate scans ([#41](https://github.com/schubydoo/withe/pull/41))

## 1.0.0 (2026-08-17)

### Features

- First stable release: the read-only dashboard over the Renovate CE you already run, published as a signed multi-arch container image. ([#8](https://github.com/schubydoo/withe/pull/8))
