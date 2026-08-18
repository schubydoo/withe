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
