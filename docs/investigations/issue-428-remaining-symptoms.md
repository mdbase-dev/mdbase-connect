# Issue 428: remaining symptoms

Investigation, not a claim that every reported failure is reproduced or fixed.
Source baseline: beta103 (`1102ab2750b8144ee3bf3f69e58fbd3e20578738`); diagnostic commit `6f96fc3d`.
The earlier JSON-output fix is separately reviewed in PR #442.

Native diagnostic run: https://github.com/mdbase-dev/mdbase-connect/actions/runs/35161513937
All five jobs passed, including missing-root and visible-console diagnostics.
No production account, credential, collection, Windows task, or permission was changed.

## 1. Unexpected visible daemon console — reproduced

The native fixture installs the official beta99 CLI using the current production
scheduler implementation and runs its real daemon under the runner's interactive
account, with an InteractiveToken/LeastPrivilege task. A separate probe attaches
to that daemon's console and calls GetConsoleWindow/IsWindowVisible.

Observed: `attached=true`, `hasConsoleWindow=true`, `visible=true`.
The artifact is `issue428-console/console.json`. Daemon execution and the rest of
the normal start/stop/replacement lifecycle also succeed.

The task directly launches the console-subsystem `mdbase.exe` with
`connect daemon run`. Unlike `service::spawn_detached`, this path does not launch
through CreateProcess with CREATE_NO_WINDOW. Desktop execFile's windowsHide and
PR #442's scheduler-command hiding affect their subprocesses, not the separately
scheduled daemon. Task Scheduler's hidden-task setting is not a background-process
launcher and should not be treated as a solution.

This is a product launch-path defect, not evidence that users manually launched
an extra daemon. The scheduler definition and relevant mirror code have no source
difference between beta101 and this baseline. This fixture uses a release binary
and real task but is not a packaged beta101 Electron/logon test.

Next: implement an explicitly background, console-free daemon launch while
preserving the foreground CLI, stable runtime ownership, task start/stop behavior,
and bounded log access. Do not globally hide ordinary CLI consoles or ship a fix
that merely hides schtasks while leaving the scheduled process unchanged.

## 2. Mirror “Filesystem error … file specified (os error 2)” — matching cause reproduced

`MirrorManager::build_mirror` calls `validate_mirror_root` before constructing the
mirror. Its initial fs::canonicalize returns an unannotated ConnectError::Io if
the saved root path no longer exists. That produces the exact error family in
the screenshot: `io_failed`, `Filesystem error: ...`, and Windows error 2.

The new `issue_428_missing_root_is_bare_io_but_missing_state_is_not` test proves:

- a real directory with no mirror state.json can be inspected successfully;
- renaming that directory makes the same inspector fail with NotFound/io_failed;
- native Windows returns raw OS error 2;
- the background retry classifier treats this as retryable;
- inspection does not recreate the missing root;
- restoring the directory restores successful inspection.

The inspected operation uses the same build_mirror root check as synchronization;
it makes no network call and uses no credential store. It is not an end-to-end
replication fixture. This test passed on Linux and Windows.

This narrows the screenshot toward an unavailable saved mirror folder, not a
missing task executable or necessarily a missing Markdown/state file. A moved,
renamed, unavailable drive, or stale mirror entry could produce it. It does NOT
prove which path or cause applies to Nhan. The credential-renewal/persistence path
can also produce raw I/O errors and has not been excluded using reporter evidence.

Next: obtain that mirror's local status and confirm whether its configured folder
exists, without uploading its contents. Improve the missing-root diagnostic with
a resource-specific code and useful local explanation; preserve bounded retries
for temporarily unavailable drives. Never silently create a replacement empty
folder or delete the saved mirror/grants.

## 3. Invalid connector credential — rejection path established, origin unknown

The server's requireConnector emits this exact message when connectorFromRequest
finds no matching accepted identity. Its query requires a matching token hash,
a non-revoked connector and a non-suspended user. There is no connector-token
expiry predicate. A normal expiring browser session alone does not explain it.
Missing/mismatched tokens, a removed/revoked computer, an absent record/account,
a suspended account, or an incorrect server/state identity remain possibilities.
No reporter-specific account inspection has been performed.

Reran two existing daemon tests successfully:

- `invalid_account_credential_does_not_invalidate_existing_direct_grant`: a
  synthetic server 401 causes the exact account-management error while encrypted
  same-computer reads using an existing cached grant continue on the SAME agent.
- `terminal_http_rejection_stops_the_real_relay_owner`: real relay ownership stops
  reconnecting after terminal HTTP rejection and records attention-required state.

This explains why “something still works” does not disprove account rejection.
It does not establish working Android-to-PC synchronization, the reporter's actual
route, or why their credential was rejected. The code intentionally does not
ignore a 401 or automatically replace the user's identity.

Next: ask for non-secret connector ID/server origin/account status and whether
the computer was removed/reconnected. Correlate with authorized server-side
revocation/audit evidence if available. Do not ask for tokens or secret-store files,
or reset identity before preserving the diagnosis.

## 4. TaskNotes validation loops/timeouts/crashes — not reproduced

The report does not identify which app/screen performs validation, the exact
message, vault size, or which process crashes. Those distinctions matter: the
browser authorization setup assessment, SDK startup assessment/live description,
TaskNotes application loading and daemon filesystem mirror are different owners.

The SDK `application-session.ts` verifies setup and then performs a live contract
description. Its verification generation fences stale results, and the normal
path has bounded requests and terminal blocked/authorization-required outcomes.
The source does not by itself establish an infinite retry loop.

The TaskNotes checkout uses a vendored beta96 SDK. On Node 24.19.0, the existing
SDK application-session suite passed 40 tests (including timeout/cancellation and
stale-publication tests); TaskNotes' SDK callback and cloud-collection suites
passed 19 tests, including setup review/conflict handling. These are focused tests,
not a reproduction of the reporter's Android installation or vault.

A broader collection-gate test attempt was blocked by the local checkout's missing
`@tanstack/react-virtual` dependency (6 failed, 19 passed), not by an observed
product validation loop. No dependency or product files in TaskNotes were changed.

There was a real setup-performance problem in earlier engine versions: repeated
full-collection staging and processing unrelated JSON could exceed request/capture
budgets. Engine PR callumalpass/mdbase-rs#79 (pinned by Connect #435/beta102) addresses
that measured issue. Jemabaris reports problems on build102 too, so that work must
not be presented as an established fix for their report.

Next: request a short screen recording or exact screen/error text, TaskNotes app
and plugin versions, which process exits, and approximate vault size. Then build
a synthetic fixture matching that phase. Do not label every wait as a validation
loop or extend deadlines indiscriminately.

## Scope and handoff

Only diagnostic/test code changed on `investigate/428-remaining-symptoms`.
No additional production fix, merge, release, issue reply, identity reset, LAB
mutation or real-user data access occurred. PR #442 remains a separate JSON fix.
