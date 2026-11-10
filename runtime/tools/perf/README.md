# Performance tooling

Performance scenarios use synthetic corpora; the CI baseline is `tools/perf/baseline.json`.
The code is in `crates/bench` (`mdbn-bench`, test-only).

| Tool | What it does |
|---|---|
| `mdbn-corpus` | Writes a deterministic synthetic vault to disk. |
| `mdbn-perf run` | Runs the scenarios at the corpus sizes you pass, prints a table and writes a JSON report. |
| `mdbn-perf gate` | The CI regression gate (see below). |
| `tools/perf/wasm-init.mjs` | Times WASM engine start in Node and, optionally, in an isolated headless Chromium. |
| Edit-journey trace spans | Timing boundaries across submit, confirm and visible application. |

## Running (timing runs on the reference laptop, never the build VM)

```sh
rcargo --pull release/mdbn-perf --pull release/mdbn-corpus build --release -p mdbn-bench
uptime                                  # note the load average with the results
./target/release/mdbn-perf run --sizes 1000,10000 --iters 30 --cold 3 --out perf.json
./target/release/mdbn-perf run --sizes 50000 --iters 10 --cold 1 --only native,replica
./target/release/mdbn-corpus --notes 10000 --profile real --attachments light --out ~/perf-vault-10k
```

The work directory defaults to `target/perf`, inside the worktree and never `/tmp`. Each
`run` writes the corpus there again from scratch, because the scenarios edit it.

## WASM init

1. Build the artifacts:

   ```sh
   rcargo --pull wasm32-unknown-unknown/wasm-release/mdbn_wasm.wasm build --locked -p mdbn-wasm \
     --lib --target wasm32-unknown-unknown --profile wasm-release --features app-runtime
   ```

2. Copy the artifact to `target/wasm/app-runtime.unopt.wasm`.
3. Run `wasm-opt -Oz` with the flags in `xtask/src/main.rs` `WASM_FEATURES`, using
   `tools/wasm/node_modules/.bin/wasm-opt`.
4. Then:

```sh
npm ci --prefix packages/sdk
npm i --prefix tools/perf --no-save playwright-core   # only for --chromium
node tools/perf/wasm-init.mjs --app target/wasm/app-runtime.wasm --runs 20 \
  --chromium ~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
```

Chromium runs headless with its own profile in `target/perf-chromium-profile/`.

## Scenarios

| Area | Scenarios | Stack |
|---|---|---|
| `native.*` | `open_cold`, `open_warm`, `commit`, `edit_visible`, `query_tasks_open`, `query_tasks_all`, `search_title`, `backlinks_hub`, `backlinks_random`, `external_edit_rescan` | The public `mdbase` library: `FileStore` + native SQLite + `NativePlatform`, the daemon's composition. If a cold open fails, it falls back to `open_incremental`. |
| `replica.*` | `seed`, `join_replay`, `edit_visible`, `commit`, `query_tasks_open`, `catchup_1k`, `snapshot_build`, `join_snapshot` | Three devices over `MemStore` with production sealing (`KeyringSealer`) and `CorePlanner`, syncing through the in-process fake log. This is CPU only: no network, no disk. |
| `bases.*` | The five unchanged TaskNotes views from `crates/replica/src/tests/data/bases-first-slice.json`, plus `probe_*` | The replica's Bases executor, timing capture plus execute. The `probe_*` scenarios each add one real-shaped note and record whether the view still runs. |

## Corpus assumptions

The corpus is synthetic and seeded. It contains no real user data. The shares below are typical
of personal Obsidian vaults. They are assumptions to revise when real anonymised statistics are
available.

- **Real-shaped profile:**
  - 60% general notes in a 1–3 level folder tree under 16 areas, about 70% with frontmatter
    (tags, aliases, dates, ratings, sources, link-valued properties);
  - 10% daily notes;
  - 28% TaskNotes task notes in `TaskNotes/Tasks/`;
  - 3% project notes;
  - 2% long reference notes of 20–80 KB.
- **Note size:** 40% under 800 B, 35% 0.8–3 KB, 20% 3–10 KB, plus the long notes.
- **Links:** about 2–4 wikilinks per KB of body. Preferential attachment means project and
  early notes become hubs. 10% of links have an alias and 10% point to a heading. Notes also
  contain embeds and checkboxes, about 25% of notes have task lists, and some paragraphs have
  inline `#tags`. Titles include non-ASCII (é, ü, 日本).
- **Tasks:** shaped like TaskNotes tasks:
  - `status`: 45% open, 20% in-progress, 30% done;
  - `priority`, `due` (60%) and `scheduled` (40%);
  - `contexts`, `projects` as `[[links]]`;
  - `timeEstimate`, `recurrence` (8%), `blockedBy` (10%), `dateCreated`/`dateModified`;
  - `tags: [task]`.
- **Attachments:**
  - `light` (the default): one 10–200 KB image per 10 notes, and one 2–10 MB file per 2,000
    notes;
  - `full`: one image per 4 notes, 10% of them up to 2 MB, and one 5–50 MB file per 500
    notes;
  - the bytes are incompressible, behind real PNG, JPEG, PDF, MP4 and ZIP magic numbers.
- **Tasks profile:** 98% task notes and 2% projects.

## CI regression gate

`mdbn-perf gate --baseline tools/perf/baseline.json` runs the scenarios twice over:

- **At 1k notes** (15 iterations, 3 cold opens; every area). Each scenario's fastest iteration is
  divided by a fixed calibration workload, which roughly cancels out runner speed. A ratio fails when
  it is more than the baseline's `threshold` (2.5×) above the baseline's `ratios` entry.
- **At 10k notes** (5 iterations, 1 cold open; `native` and `replica`, since the Bases executor
  refuses above ~50–75 tasks). For each scenario the gate takes the growth of its fastest iteration
  between the sizes as a log-log slope: `ln(t10k / t1k) / ln(10)`, so 0 is flat (backlinks, a
  commit), 1 is linear (a cold open) and 2 is quadratic. A slope fails when it is more than 0.5 above
  the baseline's `growth` entry.

A check fails the gate only when it fails in two consecutive runs; the gate re-runs both sizes to
confirm. A scenario missing from the baseline is reported and not checked; one in the baseline but
missing from the run fails.

The gate is loose by design. It catches complexity regressions, such as linear turning quadratic or
an index silently not used, and does not catch 10% drifts. The 1k ratio alone cannot see a
scenario that is linear in corpus size when it should be flat, because at 1k notes the extra cost is
small; the growth check can. Growth needs no calibration (both sizes run on the same runner minutes
apart), so its limit is tighter than the ratio's: the 0.5 margin is half a complexity class, ×3.16
in time on top of the recorded growth. A whole class (flat to linear, linear to quadratic, a
logarithmic index lookup turning into a scan) is ×10 and fails clearly. The margin absorbs what a
slope legitimately varies by: a ×1.5 outlier in one size's fastest iteration moves the slope by
0.18, n log n against n is 0.12, fixed costs amortise differently on different machines, and a
10k corpus fits different caches on the reference machine and on a runner.

The baseline records growth as the scenario behaves today. Paths that are linear but should not be
(title search and unbounded queries scan every record, a warm open re-reads every document) are
recorded as linear, so getting worse fails and fixing them shows up as a lower slope in the next
baseline refresh. Until the baseline has a `growth` map, the gate prints every slope and checks none.

On a GitHub runner one gate run costs, estimated from the reference machine's 1k minimums and the
1k→10k open costs in `docs/cli-data-commands.md`, roughly a minute at 1k and one to two at 10k,
mostly the single 10k cold open (about 11 s on the reference machine, extrapolating its 1k time linearly) and the replica setup
(seed, replay, snapshot), which has no recorded 10k time. A confirming re-run doubles it. It runs in
`.github/workflows/runtime-perf.yml` (repository root) nightly, on demand, and on PRs labelled
`perf`, so it does not cost minutes on every PR.

`mdbn-perf run` notes which path `replica.query_tasks_open` took (indexed or the per-record
fallback, with the reason) from `Replica::query_stats`. The native scenarios go through the public
`mdbase` library, which does not expose those counts; their growth slopes show the same thing.

To refresh the baseline, on the reference machine (quiet, `uptime` load near zero, release build):

```sh
rcargo --pull release/mdbn-perf build --release -p mdbn-bench --bin mdbn-perf
./target/release/mdbn-perf gate --baseline tools/perf/baseline.json --write
```

`--write` runs the gate twice and keeps the lower value of each ratio and slope. Say why in the PR.
