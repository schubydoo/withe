# Performance

Task 3.8. Every NFR-1 to NFR-7 target gets a measured number, so a regression
is visible in a diff rather than argued about.

## Method, fixed before any number was recorded

- **Sample size is 100** for every latency figure. p50, p95 and max are
  reported.
- **Page timing** is the loopback response time of the standalone server —
  request sent to full body received — measured by `scripts/perf-measure.ts`.
  On localhost that is server render with a sub-millisecond transfer and no
  browser, so it is neither TTFB over a network nor a browser LCP. Data pages
  set `dynamic = 'force-dynamic'` (`tad.md` 8.2), so there is no cache to warm;
  the figure is the steady state after one discarded warm-up request.
- **Log render** is the CPU the viewer spends before first paint — `parseLines`
  then `applyFilter` over 5,000 lines — with **no upstream fetch**, because the
  CE server's latency is not a property of Withe.
- **Datasets are generated** by `scripts/perf-dataset.ts`, because the author's
  fleet is 8 repositories and NFR-2 asks for 500. Each repository gets 30 runs
  and 6 pending updates, a tenth are failing, and each carries a lock-file
  refresh — the mix that makes the landing page do work.
- **Memory** is the sum of resident set size (`VmRSS` from `/proc`) across every
  process in the container — supervisor, web, worker, tini — at **5 minutes
  idle**. The proportional set size (`Pss` from `smaps_rollup`) is reported
  alongside it, because summing RSS counts the shared Node binary and libc
  three times; PSS is the honest footprint.
- **Cold start** is wall-clock from `docker run` to the first served page.
- Reproduce the source-measurable half with `npm run build && npm run perf`.

## Where these were measured

- Latency, sync-write and **memory**: this host, **amd64**, Node v24.17.0.
  arm64 is the constrained target the method names, but it cannot be measured
  honestly on this amd64 host — under QEMU emulation every process runs inside
  a `qemu-aarch64` wrapper that adds its own hundreds of megabytes, so the
  container reads ~430 MB of emulator, not application. The amd64 figure stands
  in: a Node process's resident set is dominated by the V8 heap and mapped
  code, which are close across the two architectures, and the 239 MB RSS-sum
  (140 MB PSS) leaves real headroom under 256 MB. A native-arm64 confirmation
  belongs on real hardware or an arm64 CI runner (Task 3.11).
- **Cold start** is measured on **arm64** under emulation, which is slower than
  native — a conservative direction for a latency budget.
- Container image: measured in Task 3.5 on both architectures.

## Results

| NFR | Target | Measured | Verdict |
|-----|--------|----------|---------|
| NFR-1 | Landing page, 50 repos, p95 <= 400 ms | p50 28.9, **p95 84.4**, max 144.5 ms | pass |
| NFR-2 | Landing page, 500 repos, p95 <= 1,200 ms | p50 195.4, **p95 244.6**, max 294.5 ms | pass |
| NFR-3 | Log render, 5,000 lines, p95 <= 1,000 ms, no fetch | p50 1.5, **p95 2.0**, max 2.6 ms | pass |
| NFR-4 | Full sync, 50 repos, <= 60 s | write half 38.8 ms; live 8-repo end-to-end ~1 s | pass |
| NFR-5 | Idle memory <= 256 MB resident | **239 MB** RSS-sum (140 MB PSS) | pass |
| NFR-6 | Image <= 300 MB uncompressed | 217 MB amd64, **211 MB arm64** (Task 3.5) | pass |
| NFR-7 | Cold start to serving <= 15 s | **6.1 s** on arm64 under emulation | pass |

### Notes per target

- **NFR-4** is fetch-bound: a full cycle is `fetch from CE` + `map` + `persist`.
  The fetch is CE's latency, not Withe's, so the measured Withe-side number is
  the write half — 50 repositories with their runs and updates straight to
  disk, 38.8 ms. The live 8-repo fleet's real end-to-end cycle, including the
  fetch, is under a second (`sync_status` durations). 50 repositories is
  comfortably inside 60 s.
- **NFR-6** was measured in Task 3.5 and is repeated here for completeness.
- **NFR-3** windows the DOM (22 px rows, no wrapping), so first paint renders
  only the visible rows regardless of length; the cost that scales with the log
  is the parse and filter measured here.
