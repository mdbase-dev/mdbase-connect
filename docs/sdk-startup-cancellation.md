# Superseded startup verification cancellation

## Introducer

`bb798609b3180a203242979dbbe5119c45dadbab` — **Overlap verified readiness and
honor adaptive cursor page sizes (#537)** — introduced the regression between
beta.119 and beta.123. It moved setup assessment onto the readiness controller
while overlapping it with live contract verification.

The public session/collection-client regression was replayed against archived
SDK sources, with the synthetic transport accepting the older SDK's optional
request signal. The protocol dependency was held constant; this isolates SDK
behavior rather than claiming complete historical release qualification.

| SDK source | Replacement reaches ready |
| --- | --- |
| beta.119 (`e8d251bd`) | Yes |
| #537 parent (`90c3590a`) | Yes |
| #537 (`bb798609`) | No: raw `AbortError` escapes startup |
| #549 parent (`0aa5a62b`) | No: same failure |
| #549 (`80105fbe`) | No: same failure |
| beta.123 (`98992fcc`) | No: same failure |

#549's description caching can affect timing but is not required for the bug.
`request-coordinator.ts` has no changes in the beta.119–beta.123 interval.

## Ownership failure and fix

1. Startup starts setup assessment and contract verification for generation A.
2. A direct-access/route update, or selection change, publishes a new base
   snapshot. Refresh cancels A and starts generation B on its own controller.
3. A's read transport rejects with its abort signal's native reason. Expected
   SDK errors become typed outcomes, but this raw exception propagates through
   `Promise.all` before the existing stale-success check can run.
4. Startup interprets the exception as a genuine fault, destroys the base
   session currently serving B, and returns to `not_started`. B can no longer
   publish `ready`.

The rejection path now applies the same ownership fence: ignore an exception
only if the verification is superseded, its own controller was aborted, and
it is that signal's exact reason or a typed `operation_cancelled` error. Its
existing identity-checked cleanup cannot clear the replacement controller.
There is no new state, retry, authority call, error-name heuristic, or global
error suppression. A redundant assessment-result temporary was removed.

A genuine programming exception still rejects `start()`. Current typed
assessment failures retain their existing blocked/reauthorization behavior
and original problem; they are not promoted to ready. Caller cancellation, startup deadlines, and
terminal destruction retain their existing lifecycle behavior.

## Consumer exposure and migration

- **TaskNotes:** its beta.123 package patch implements the same scoped guard.
  Remove it after upgrading to a release containing the source fix. Keep
  genuine-error handling; no application retry or startup workaround is needed.
- **Writer:** the inspected checkout pins beta.123 and uses SDK application
  sessions, managed type-pack provisions, persisted browser selection, and
  `directAccess: "auto"`. A relay/checking-to-direct or unavailable transition
  during assessment can trigger the same race. Already-direct startup, or a
  session without an in-flight managed setup assessment, does not trigger this
  specific failure. This is code-path exposure, not a reproduced Writer incident.
- **Reader:** the inspected Connect wrapper also uses SDK application sessions
  with auto direct access; Reader and extension declarations provision type
  packs. It will have the same exposure on affected SDK versions. Its inspected
  package currently pins beta.112, before the introducer, so that checkout is
  not affected by this particular regression. Hosted collections avoid the
  automatic local-network transition, but selection changes can still
  supersede an in-flight assessment on affected SDKs.

No public API, persisted representation, authorization boundary, or protocol
version changes. No minimum authority upgrade is required.

## Regression coverage

`packages/client/src/application-session-startup.test.ts` uses public
`MdbaseApplicationSession`, `MdbaseMemorySelection`, and
`MdbaseCollectionClient` APIs over a synthetic wire transport. It covers:

- route refresh to relay/unavailable and direct/available while assessment waits;
- both installed contract-selector bundles and canonical declarations;
- delayed replacement verification retaining its connection and reaching ready;
- selection clearing yielding `unselected`, not a startup fault;
- genuine superseded/current exceptions, including an unrelated `AbortError`;
- visible current typed assessment failures, including `operation_cancelled`.

The cancellation cases failed before the source fix; genuine-failure cases
passed before and after it. Client/public/packed API validation introduces no
new exports.

The browser bundle grows from 70,192 to 70,229 gzip bytes (+37), below its
73,728-byte hard ceiling. Review-threshold/baseline warnings are already present
in the parent build; the budget was not raised.

## Qualification

- Node v24.19.0: 540 client tests across 29 files pass, including nine new
  regressions. Public API inventory, packed root/advanced/crypto/testing API
  compilation, and standalone strict compilation of the new regression pass.
- All Node gates in the single `pnpm ci:local` run pass: install, release/version
  checks, dependency audit, architecture, build, typecheck, tests, and package
  audit. Rust formatting and feature checks also pass.
- `pnpm test:fast` exits 101 at Rust compilation; `pnpm ci:local` exits 1 with
  Rust clippy/test compilation failures; `pnpm e2e` exits 1 during its Rust
  workspace preparation, before the runtime scenario executes. Each hits the
  unchanged assertion at `crates/connect-hosted-provider/src/provider.rs:46`:
  Connect expects semantic projection format **8**, but the clean shared
  `../mdbase-rs` checkout (`af73732`) exports **9**. No Rust files or shared
  dependency files were changed, and these gates were not retried.

Local logs: `/tmp/sdk-startup-{fast,ci,e2e}.log`; history replay evidence:
`/tmp/sdk-startup-history.log`. Resolving the shared Rust dependency mismatch
and completing runtime E2E qualification remain deferred to the coordinator.
