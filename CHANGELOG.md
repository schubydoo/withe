## 1.4.0 (2026-09-11)

### Features

- Add a cross-repo pending-updates page at /updates. It lists every pending update grouped by dependency, so you see every repository waiting for the same update on one line. Filter the list by update type, including security. The dashboard's pending-updates count now links to it. ([#95](https://github.com/schubydoo/withe/pull/95))
- Read live pull-request state from GitHub. A merged or closed Renovate pull request now leaves the dashboard within one sync. Before, Withe read pending updates only from the newest Renovate job log, which is a snapshot. A merge stayed on screen until Renovate ran again, up to about one hour on an hourly runner. To turn this on, set WITHE_GITHUB_TOKEN. Each sync, Withe reads the pull-request numbers from the log again. It confirms each pull request is Renovate's by its branch prefix and its author. It marks the merged and closed ones. Withe never edits your renovate.json. Withe never stores the token. If the forge is unreachable, Withe keeps the log's state. ([#92](https://github.com/schubydoo/withe/pull/92))
- When the GitHub rate limit is low, Withe warns on every page. The health banner shown on each page now also carries this warning. It reads the forge headroom from the same /api/health poll, so no second poller is added. When headroom drops below 20%, an amber bar names how many requests are left and links to the health page. ([#97](https://github.com/schubydoo/withe/pull/97))
- Show the GitHub API rate limit on the health page. When Withe reads live pull-request state, it records how much of the token's rate limit is left. A new Forge rate limit section shows that. Below 20% headroom, the page warns that a spent limit leaves merged pull requests on screen until it resets. The limit is the GitHub token's, shared with Renovate, so it is shown once for the install. ([#96](https://github.com/schubydoo/withe/pull/96))

### Fixes

- Fix the update-type and repository filter menus in dark mode. The select and each option now set an explicit background and text color for both themes. Every option is readable in dark mode, not only the hovered row. Before, the option list showed faint text on a dark background. ([#102](https://github.com/schubydoo/withe/pull/102))
- Align the columns on the cross-repo pending-updates page and fix the filter in dark mode. The page now renders one table for the whole list. The version, type, and pull-request columns line up across every dependency group. The update-type filter follows the page theme, so its options stay readable in dark mode. ([#101](https://github.com/schubydoo/withe/pull/101))

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
