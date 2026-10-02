## Fixed

- The editor's guided person setup installs `mdbase.contact` 1.3.0, whose
  Person v3 starter neither declares nor requires `type`. People created in
  collections whose `settings.explicit_type_keys` is not `[type]` (such as
  `[mdbase_type]`) no longer fail validation with `schema_required: type`.
  Person v3 carries `upgrade_from` the 1.2.0 Person v2 seed. When a collection
  has that earlier starter, Settings now offers **Review Person type update**:
  the guided review names the upgraded type, says whether collection edits are
  kept by a clean merge, and applies only the reviewed assessment digest.
  Conflicts, deletions, downgrades, managed-resource updates and seed updates
  without a matching `upgrade_from` still stop for review in Types. No API
  changes.
