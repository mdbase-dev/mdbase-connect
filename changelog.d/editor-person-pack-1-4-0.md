## Fixed

- The editor's guided person setup bundles `mdbase.contact` 1.4.0, whose Person
  v3 starter lists both earlier starters (Person v2 from 1.2.0 and Person v1
  from 1.1.0) as `upgrade_from` baselines. Collections still on the Person v1
  starter, which implements `mdbase.person` 1.0.0, now see **Person type update
  available** and can review the same in-place upgrade instead of being asked to
  set up person records. The released Contact seed is left as it is. No API
  changes.
