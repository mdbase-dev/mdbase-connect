# Tiny LAB fixture start

The privileged existing migration start route accepts an explicit small LAB profile:

```json
{"profile":"lab-fixture-v1","inventory":{"batch_id":"lab-fixture","membership_revision":"1","membership_digest":"<64 lowercase hex characters>","membership_changed_at":"<canonical UTC timestamp>"}}
```

Use the exact inventory DATA returned by the existing cohort `archive-binding` read, not this illustrative value. The configured environment must be literal `lab`. The original migration token authentication, account backend/suspension semantics, release/pause gates, frozen topology and exact current inventory checks remain in force. The frozen cohort must contain exactly that one account and exactly one owned hosted collection. Retries recheck inventory. Other account inventory is not silently omitted or migrated.

This creates the original account start claim only. It does not create an archive acceptance, verify exported bytes, prove log caller admission, complete target creation, authorize an account flip or establish native readiness. Ordinary start requests—including ordinary LAB requests—still require their original fresh accepted archive; staging and production cannot select the fixture profile.

Before fencing, the operator retains the authored fixture baseline and an ordinary authenticated read-only legacy export of every fixture record, file and retained version, with names, identities and hashes. The migration must not delete legacy objects. Exercise an authenticated route-back before final cutover. These are LAB run-one recovery requirements, not substitutes for staging's global archive prerequisite. Unknown original outcomes remain stops; a retry must not replay or remint work.

The verified-archive `receiving-v1` view is separately available in LAB for its existing LAB archive profile. It remains accepted-archive DATA, not an archive producer, and is not required for the tiny fixture profile.

## Completion without an archive

A cohort normally completes when its accepted archive exists for the current membership revision and every member has flipped. A tiny LAB fixture cohort has no archive acceptance, so in environment `lab` only it completes instead at the final flip when all of these hold under the cohort lock:

- every member started with the `lab-fixture-v1` profile, and its start audit binds the cohort's current name, membership revision, membership digest and change time;
- no member is excluded, and every member is on the next backend with a flip record;
- each member's flip names exactly its current hosted collections, each cut over and routed as a cloud copy, and its evidence digest equals the digest recomputed from those cutover records.

Completion writes `completed_at`/`completed_revision` and a `next_migration.lab_complete` audit event with the membership digest and the cohort's cutover evidence digest. The completion readback (invitation acceptance and imported-timer effects) accepts that event only when the cohort has no archive acceptance, the event names the completed revision, and the owner's LAB start binding carries the same membership digest; every other readback check is unchanged. Any other configured environment, including `staging`, `production`, `LAB` or none, never writes the event, so a fixture-profile cohort there stays incomplete. A completed revision cannot be unfrozen.
