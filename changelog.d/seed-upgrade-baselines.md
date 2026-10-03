## Changed

- Seed type upgrades follow mdbase-spec 05A's upgrade baselines
  (mdbase-dev/mdbase-spec#59), with mdbase-rs 056db73 pinned
  (callumalpass/mdbase-rs#108). A type pack's seed `upgrade_from` may now be one
  baseline or a non-empty list of `{ digest, document, version? }`; manifest
  validation (`validateAppManifest`, and the new `validateTypePackProvision`
  in `@mdbase-dev/connect-protocol/manifest`) rejects baselines on non-seed
  types, digest mismatches, duplicates, the resource's own digest, a different
  frontmatter `kind` or `name`, and a `version` the document does not declare,
  at the offending baseline's path. The single-object form is unchanged.
  Engines choose the merge baseline from the lock's seed `origin_digest` and
  preserve, with a reason, a seed whose origin is unknown or unlisted. The
  SDK's type-pack assessments add `upgradeBaseline` to seed updates, and
  receipts add `originDigest`. The devkit's `defineTypePack` accepts
  `upgradeFrom: [{ document, version? }]` on seed types. The editor's guided
  Person setup accepts a starter upgrade only when the engine reports a
  baseline the bundled pack declares, and says **Person type kept as it is**
  when the engine preserves the type with a reason.
