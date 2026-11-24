# Synthetic production app timings

Run `node scripts/app-timings/run.mjs /private/config.json` on a dedicated GCP
browser runner. This is synthetic monitoring of registered production test
accounts, never customer data or real-user telemetry. Do not run browsers on the
minipc or on desk hosts. The default is one cold open followed by three warm
visits for Editor, Writer and TaskNotes at 100, 1k and 10k synthetic records.

Production origins and first visible record selectors (checked against each
app's repository) are fixed in `scripts/app-timings/results.mjs`: Editor
`https://editor.mdbase.dev` (`.note-row:not(.file-row)`), Writer
`https://writer.mdbase.dev` (`.manuscript-row`), TaskNotes
`https://app.tasknotes.dev` (`.task-row[data-task-id]`). Use list views with no
saved filters. The corpus must contain records each app recognizes: explicit
`task` and `writer-manuscript` types, titles, open task status and a fixed past
due date so Today always has rows. Finish each app's ordinary setup review once
before measuring. A visible Set up review fails immediately with
`setup/setup_required`; the suite never accepts setup during a timed visit.
Preserve these registered, persistent fixtures between runs.

Reader is omitted: the production MV3 extension's `capture.html` is a capture
side panel, not a collection library. Its library opens the separate Reader
website. Although the released extension ZIP is downloadable, loading it would
not provide a comparable first-records surface. Its production ZIP also omits a
manifest public key, so unpacking it changes the extension ID and app origin.
There is no Reader timing claim.

## Sessions and cold/warm meaning

Keep one saved **Connect portal** session per registered account, in a private
Playwright storage-state file containing only `connect.mdbase.dev` cookies and
no origins. Reuse the registered `prod-big` alias when it has capacity; the
private account registry and production E2E policy govern credentials and
fixture names. Account identifiers, credentials, collection IDs and browser
state stay outside this public repository and reports.

Each app/size cell runs in a new on-disk browser profile, as a person's own
browser has, and the profile directory is deleted after the cell. Ordinary
Playwright contexts are off the record: Chromium keeps their origin-private file
system in memory behind an IPC round trip of about a millisecond per write, which
made cold opens several times slower than in a normal profile (#1648). A cold
profile has empty app storage, HTTP cache and service-worker state. Only the
saved Connect login cookies are supplied. The script follows the app's Sign
in button and approves the requested fixture in the portal, then brings the app
tab to the foreground after the portal confirms approval, so the consent flow
and app animation frames each run in the foreground as they do for the person.
Consent is recorded separately from navigation start to the approval response
headers, using Chromium's request timing. Cold `first_records` and the envelope
duration start at that response; they exclude consent. Three subsequent warm
navigations use the same fully opened context and retain app installation,
collection storage, HTTP cache and service worker. Warm visits run only after
cold succeeds; otherwise they report `cold_incomplete` with zero visits.
Profiles are closed and deleted after the cell. The SDK's protected installation contains a
nonextractable IndexedDB key; clearing storage and restoring JSON auth is not a
valid way to simulate an authorized cold open.

An expired portal login yields `auth/auth_expired` for every cell, without
trying passwords or classifying it as an app outage. Other preflight failures
use `auth_unavailable`. Renew that account's saved portal session outside the
timed run; never inject passwords into the suite. Keep its file mode 0600. The
script saves refreshed portal cookies after a successful preflight.

Each cold run creates a temporary app installation. A private ledger records
only those installation IDs. The suite revokes exactly these installations via
the public account API after each app/size cell and verifies their absence. It
cleans an interrupted run's ledger before another run. Cleanup failure stops the
run; resolve it before re-enabling daily runs. Persistent collections and other
installations are untouched. No screenshots, content, network, console or
storage dumps are recorded.

## Measurements and ingestion

The init script follows Editor's `tests/startup-profile.spec.ts`: a mutation
observer installed before navigation detects records. Here it waits two
animation frames and requires a visible row in the viewport. `first_records`
starts at approval response headers for cold and navigation for warm; it is not
full indexing or synchronization. Cold record windows are 180 seconds at 100,
240 seconds at 1k and 600 seconds at 10k, allowing the SDK key-grant wait and
large replay; warm has 45 seconds. In the off-the-record contexts used until
#1648's follow-up, a 1k cold open on the runner's two vCPUs took up to 177
seconds and a 10k one about six minutes; in an on-disk profile they took about
21 and 72–81 seconds, so the cold series steps down at that change. All cells and visits are
sequential, including on one collection.

Opening stage durations (`joining`, `opening_store`, `connecting_log`, `syncing`,
`key_wait`, `snapshot`, `apply`, `verifying_read` and `checking_setup`) are
computed from the SDK's main-thread `mdbase:open:stage:<stage>` performance
marks, clipped to approval start and to `open:ready` / first records, summing
repeated visits to a stage. Only those fixed stage names and monotonic
timestamps are used. TTFB
is navigation `responseStart - requestStart`. FCP and buffered LCP are read at
the first-records observation (or timeout); LCP is therefore **LCP at first
records**, not an eventual page-lifetime LCP. JS heap uses Chromium's
`JSHeapUsedSize` at that point and is reported separately in bytes in the local
report.

When the SDK marks are present, `open_approved`, `open_ready`, `first_query` and
`open_first_records` are durations from `mdbase:open:requested`. The first query
mark may precede readiness; it is not proof of visible records. `render` is the
interval from `open:ready` to visible rows when that mark is available. Missing
marks are omitted while apps await an SDK repin. See `sdk-performance-marks.md`
after the separate SDK change lands.

A served `mdbase-build` meta tag or the source suffix of the served entry script
supplies the revision. Missing identity fails the sample; mixed revisions fail
the cell. Each app/size cell attempts one cold visit and three warm visits,
including 10k. Cold is therefore a single observation; warm reports per-stage
medians. Any failed warm sample fails that warm cell instead of hiding it in a
median. A skipped warm cell uses `first_records/cold_incomplete`. Each cell's
`checked_at` is captured when its visits finish, before cleanup/POST; cold is
posted after the three warm visits, well within ingest's 20-minute freshness
limit. The fixed stages produce 1–32 distinct names, including on failures.
Authentication failures stop further sign-in attempts and report zero visits for
skipped cells. Failed or missing measurements have duration 0 with failed
status; 0 is not a measured latency. A record timeout uses
`first_records/timeout`. None of these error tokens contains exception text or
URLs.

The runner POSTs the version-1 app timing envelope to `https://ops-
ingest.mdbase.dev/v1/timings`, using a bearer token read from a 0600 file. An
explicit `--collect-only` third argument records local results without reading
the ingest token or posting, for qualification while the ingest route is
unavailable; it is never selected automatically or used by the daily service.
Only fixed component/stage/error names, numeric durations, timestamp and served
build identity leave the runner. Heap bytes and sample count remain in the local
JSON report because the ingestion stages have units of milliseconds. A failed
POST stops the run, without retrying or printing response bodies or the token.
The report is written before posting, so failed ingestion remains visible.

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

`samples` configures the number of warm visits (3–7); cold always runs once.

Run aggregation/privacy tests with `node --test scripts/app-
timings/results.test.mjs` (also included in `pnpm test`). Browser validation
belongs on the dedicated VM. The suite uses the repository's existing
`@playwright/test`; no new framework or browser dependency is added.
