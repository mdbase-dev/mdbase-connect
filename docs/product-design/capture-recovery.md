# Preventing stale source-capture failures

The first recovery improvement belongs in the existing capture mechanism, not
in a repair wizard: once the original resource files are valid and stable,
revalidate them rather than keeping a refusal for bytes no longer on disk.
Never treat that as permission to discard a pending outcome or skip capture.

## Reproduced failure

An isolated Windows LAB build of the beta.143 source can retain a resource
ingestion refusal after a generated configuration briefly becomes invalid and
then returns to its exact original, valid bytes. Turning on sync still fails
with `source_capture_incomplete`, even with no displayed pending mutations.
This is a synthetic reproduction, not evidence of any customer's trigger.

Two existing mechanisms cause the stale failure:

- The filesystem store treats a return to confirmed bytes as a metadata-only
  touch, without offering the corrected resource for revalidation.
- Successful resource ingestion does not retire its own earlier deferred-set
  incident. The subsequent capture sees that historical refusal as terminal.

## Minimal correction

Use the existing observation and ingestion paths. A resource observation that
has no mutation evidence and differs from the confirmed bytes can be superseded
by an observation of those confirmed bytes. Preserve the old token and evidence;
transfer only the existing dependency and redelivery hints as `emit` already
does for other genuine source changes.

Record the dependency-read hint after observation admission even when the
quiet window, bounded read or UTF-8 check refuses source text. Those checks
still refuse the read; the hint only ensures restored bytes are revalidated
later rather than silently treated as an ordinary metadata touch.

Retire only the resource-ingestion mechanism's own deferred-set incident, and
only after the complete current resource set passes validation, completeness,
currentness and capture admission. Never clear an unrelated Integrity incident.
Do not create a new public state, repair parser, retry service or protocol.

The filesystem quiet window, holds, conflicts, pending mutation ownership,
unknown acknowledgements, registry persistence and real source-capture fence
remain authoritative. A zero display counter is not a substitute for them.
Unchanged invalid input and previously refused outcomes must still stop.

## Already-paused sources

An upgrade must preserve the original paused registration, identity and files.
The existing explicit Resume action can reopen that same local source; turning
on sync must then execute the real capture fence again. A historical failure
report is not a new authorization, and startup must not silently resume a
source whose original outcome is unknown.

The synthetic Windows case recovers on beta.143 through this existing explicit
Resume-then-sync path, without deleting or re-adding the source. That establishes
a safe path for this fixture, not a universal repair for every capture failure.
Qualification of the candidate must include upgrading an already-paused source
and a fresh transient-failure case, not just opening a clean folder.

## Follow-on prevention

Prefer small fixes at the boundary that creates each bad state:

- Keep transient, repaired resource failures from becoming permanent stops.
- Keep local readiness, completed enrollment and application consent distinct;
  a local Ready collection is not automatically selectable by a remote app.
- Remove deleted collections from application approval choices at their source;
  that separate defect is tracked independently, not repaired by recreating data.
- Continue interrupted enrollment using its original journal and outcome rather
  than creating a second attempt. Unknown outcomes remain stopped.

Only add a new action when the existing controls cannot express a proven safe
transition. Any future single-action retry must reuse the same owner-level
capture and journal gates, preserve cancellation and repeat-click semantics,
and prove behavior with pending, lost-ACK, held and unreadable-state tests.

## Delivery boundary

This is a native runtime change. A reviewed, qualified native/desktop release
and installation of that release are required; a server deployment alone does
not update installed clients. LAB acceptance does not authorize production
promotion. No customer files, paths, identifiers or logs belong in public
fixtures or release artifacts.
