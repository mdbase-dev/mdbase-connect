# SDK paging qualification (sdk-paging)

Reproduction: added `~/projects/sdk-review/bench/sdk-paging.mjs` without editing
any other fleet benchmark code. Run with Node 24:

```sh
node ~/projects/sdk-review/bench/sdk-paging.mjs "$PWD" dfc28fd9
```

The scenario bundles the baseline from `git archive` and the assigned worktree's
current source into an isolated temporary directory. Artifacts:
`~/projects/sdk-review/bench/sdk-paging-results.json` (all samples) and
`sdk-paging.log`. No canonical checkout, services, LAB, real data or accounts are
used. Baseline: `dfc28fd9` (full revision in JSON); Node v24.19.0, 30,000 synthetic
rows, 2ms injected response delay, three repetitions. Each row has both
frontmatter forms (256-character padding), so payloads are deliberately wide.

| Scenario | Before → after data calls | Delivered rows | Median wall ms before → after |
| --- | --- | --- | --- |
| Query, `pageSize: 1000` | 30 → 30 | 30,000 → 30,000 | 126.2 → 149.9 |
| View, `pageSize: 1000` | 150 → 30 | 30,000 → 30,000 | 452.5 → 153.8 |
| Query, first 100 / page 1000, pinned authority | 300 → 300 | 30,000 → 30,000 | 862.2 → 793.7 |
| Query, page 200 / `maxResults: 350` | 150 → 2 | 30,000 → 350 | 465.4 → 9.7 |
| View, page 200 / `maxResults: 350` | 150 → 2 | 30,000 → 350 | 473.1 → 5.2 |

Each scan has one additional cleanup call; maximum outstanding data requests
is one throughout. The cap fetches 400 rows from the pinned authority and delivers
350; transport JSON falls from about 20.04MB to 265KB. No protocol narrow-output
or authority scan/count cost improvement is claimed.

Paused-query and paused-view abort probes each show zero releases within 10ms
before, one after, without `next()`/`return()`. Subsequent `return()` keeps the
release count at one in both versions.

**Caveats:** this is a synthetic pinned-cursor wire authority, not a running Rust
provider or browser. Timings include fake row slicing/JSON byte counting and
real SDK normalization; no backend filtering/crypto is measured. Shared-machine
load is visible, especially the unchanged 30-call query scan, which is slower
in this sample. Request counts, caps and cleanup behavior are the robust results,
not a general client CPU performance claim. The old SDK baseline already tries
adaptive continuation limits; against newer variable-size authorities it could
ramp small first pages. This change deliberately uses portable fixed sizes;
consumers must choose the desired initial scan size instead of relying on ramps.
