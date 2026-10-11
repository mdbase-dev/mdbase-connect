# Tiny LAB fixture start

The privileged existing migration start route accepts an explicit small LAB profile:

```json
{"profile":"lab-fixture-v1","inventory":{"batch_id":"lab-fixture","membership_revision":"1","membership_digest":"<64 lowercase hex characters>","membership_changed_at":"<canonical UTC timestamp>"}}
```

Use the exact inventory DATA returned by the existing cohort `archive-binding` read, not this illustrative value. The configured environment must be literal `lab`. The original migration token authentication, account backend/suspension semantics, release/pause gates, frozen topology and exact current inventory checks remain in force. The frozen cohort must contain exactly that one account and exactly one owned hosted collection. Retries recheck inventory. Other account inventory is not silently omitted or migrated.

This creates the original account start claim only. It does not create an archive acceptance, verify exported bytes, prove log caller admission, complete target creation, authorize an account flip or establish native readiness. Ordinary start requests—including ordinary LAB requests—still require their original fresh accepted archive; staging and production cannot select the fixture profile.

Before fencing, the operator retains the authored fixture baseline and an ordinary authenticated read-only legacy export of every fixture record, file and retained version, with names, identities and hashes. The migration must not delete legacy objects. Exercise an authenticated route-back before final cutover. These are LAB run-one recovery requirements, not substitutes for staging's global archive prerequisite. Unknown original outcomes remain stops; a retry must not replay or remint work.

The verified-archive `receiving-v1` view is separately available in LAB for its existing LAB archive profile. It remains accepted-archive DATA, not an archive producer, and is not required for the tiny fixture profile.
