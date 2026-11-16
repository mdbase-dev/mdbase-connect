# Synthetic production app timings

Run `node scripts/app-timings/run.mjs /private/config.json` on a dedicated GCP
browser runner. This is synthetic monitoring of registered production test
accounts, never customer data or real-user telemetry. Do not run browsers on the
minipc or on desk hosts. The default is three sequential cold/warm pairs for
Editor, Writer and TaskNotes at 100, 1k and 10k synthetic records.

Production origins and first visible record selectors (checked against each
app's repository) are fixed in `scripts/app-timings/results.mjs`: Editor
`https://editor.mdbase.dev` (`.note-row:not(.file-row)`), Writer
`https://writer.mdbase.dev` (`.manuscript-row`), TaskNotes
`https://app.tasknotes.dev` (`.task-row[data-task-id]`). Use list views with no
saved filters. The corpus must contain records each app recognizes: explicit
`task` and `writer-manuscript` types, titles, open task status and a fixed past due date so Today always has rows. Finish each
app's ordinary setup review once before measuring. Never accept setup during a
timed visit. Preserve these registered, persistent fixtures between runs.

Reader is omitted: the production MV3 extension's `capture.html` is a capture
side panel, not a collection library. Its library opens the separate Reader
website. Although the released extension ZIP is downloadable, loading it would
not provide a comparable first-records surface. Its production ZIP also omits a
manifest public key, so unpacking it changes the extension ID and app origin. There is no Reader timing claim.

## Sessions and cold/warm meaning

Keep one saved **Connect portal** session per registered account, in a private
Playwright storage-state file containing only `connect.mdbase.dev` cookies and
no origins. Reuse the registered `prod-big` alias when it has capacity; the private
account registry and production E2E policy govern credentials and fixture names.
Account identifiers, credentials, collection IDs and browser state stay outside
this public repository and reports.

A cold context has empty app storage, HTTP cache and service-worker state. Only
the saved Connect login cookies are supplied. The script follows the app's Sign
in button and approves the requested fixture in the portal, then brings the app
tab to the foreground so its animation frames run as they do for the person. Thus cold elapsed
measurements **include automated consent**; they are not an already-authorized
open with an empty collection cache. The second navigation uses the same context
and retains app installation, collection storage, cache and service worker.
Contexts are closed after the pair. The SDK's protected installation contains a
nonextractable IndexedDB key; clearing storage and restoring JSON auth is not a
valid way to simulate an authorized cold open.

An expired portal login yields `auth/auth_expired` for every cell, without trying
passwords or classifying it as an app outage. Other preflight failures use
`auth_unavailable`. Renew that account's saved portal session outside the timed
run; never inject passwords into the suite. Keep its file mode 0600. The script
saves refreshed portal cookies after a successful preflight.

Each cold run creates a temporary app installation. A private ledger records
only those installation IDs. The suite revokes exactly these installations via
the public account API after each pair and verifies their absence. It cleans
an interrupted run's ledger before another run. Cleanup failure stops the run;
resolve it before re-enabling daily runs. Persistent collections and other
installations are untouched. No screenshots, content, network, console or
storage dumps are recorded.

## Measurements and ingestion

The init script follows Editor's `tests/startup-profile.spec.ts`: a mutation
observer installed before navigation detects records. Here it waits two animation
frames and requires a visible row in the viewport. `first_records` is elapsed
navigation time to that observation, not full indexing or synchronization.
TTFB is navigation `responseStart - requestStart`. FCP and buffered LCP are read
at the first-records observation (or timeout); LCP is therefore **LCP at first records**, not
an eventual page-lifetime LCP. JS heap uses Chromium's `JSHeapUsedSize` at that
point and is reported separately in bytes in the local report.

When the SDK marks are present, `open_approved`, `open_ready`, `first_query` and
`open_first_records` are durations from `mdbase:open:requested`. The first query
mark may precede readiness; it is not proof of visible records. Missing marks
are omitted while apps await an SDK repin. See `sdk-performance-marks.md` after
the separate SDK change lands.

A served `mdbase-build` meta tag or the source suffix of the served entry script
supplies the revision. Missing identity fails the sample; mixed revisions fail
the cell. Report per-stage medians from three complete samples. Any failed
sample fails the cell and ends further samples for that cell. A failed cold
visit skips the warm visit and reports `cold/prerequisite_failed` for it. The
local sample count is zero for skipped visits, including an expired preflight. Failed or missing
measurements have duration 0 with failed status; 0 is not a measured latency.
A timeout uses `first_records/timeout`. None of these error tokens
contains exception text or URLs.

The runner POSTs the version-1 app timing envelope to
`https://ops-ingest.mdbase.dev/v1/timings`, using a bearer token read from a 0600
file. An explicit `--collect-only` third argument records local results without
reading the ingest token or posting, for qualification while the ingest route is
unavailable; it is never selected automatically or used by the daily service.
Only fixed component/stage/error names, numeric durations, timestamp and
served build identity leave the runner. Heap bytes and sample count remain in
the local JSON report because the ingestion stages have units of milliseconds.
A failed POST stops the run, without retrying or printing response bodies or the
token. The report is written before posting, so failed ingestion remains visible.

Private config shape (replace placeholders only in a 0600 file on the runner):

```json
{
  "portal_state": "/private/account-portal.json",
  "token_file": "/private/timings-token",
  "ledger_file": "/private/installations.jsonl",
  "output": "/private/latest.json",
  "samples": 3,
  "collections": {"100": "<uuid>", "1k": "<uuid>", "10k": "<uuid>"},
  "collection_names": {"100": "<fixture-name>", "1k": "<fixture-name>", "10k": "<fixture-name>"}
}
```

Run aggregation/privacy tests with `node --test scripts/app-timings/results.test.mjs`
(also included in `pnpm test`). Browser validation belongs on the dedicated VM.
The suite uses the repository's existing `@playwright/test`; no new framework or
browser dependency is added.
