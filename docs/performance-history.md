# Operations performance history

Main-branch Server CI and Runtime CI retain informational size reports and
post them to the bench-only ops endpoint. Runtime perf also retains calibrated
scenario ratios. This adds history, not new size thresholds or release gates.

`scripts/performance-report.mjs` measures initial Editor assets with the
existing bundle-asset validator, optimized runtime/app-runtime WASM, packed
SDK archive bytes, or a full release-mode runtime benchmark JSON report.
Runtime minimum and median values are divided by that report's calibration;
raw CPU descriptions and notes are never submitted. Every report names its
exact source commit, commit date, Actions run/attempt and runner class.
The `sizes`, `sizes.wasm`, and `sizes.sdk` suites distinguish the independent
build jobs, so the WASM and SDK observations in one Runtime CI run cannot
replace each other. Normalized runtime observations use `runtime-v1`.
Untimed scenarios (`n: 0` and null timings in the existing report) are omitted,
not converted to zero or allowed to discard other measured scenarios.

Collection uses existing build outputs, not a second build. Uploads require
`OPS_BENCHMARK_TOKEN`, the `bench` channel credential configured in Cloud Ops.
Missing secrets warn; collection, artifact and bounded upload failures remain
visible without changing product qualification.
Reports are retained as Actions artifacts for 90 days, so a failed upload
does not discard the measurement. PRs cannot publish or access this token.

The corresponding ops migration, route, charts, signed CI/job timing ingestion,
and activation procedure live in `mdbase-cloud-ops/docs/ops-platform.md` under
Performance history. Reader and Writer have matching production-build
publishers. Merge/deploy/configuration is a separate operational step; this
code does not activate production collection itself.

Dependency-free collector and CI-contract regressions can be run with:

```sh
node --test scripts/performance-report.test.mjs scripts/lib/ci-local.test.mjs
```
