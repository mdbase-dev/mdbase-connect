## Fixed

- Manifest validation and the devkit's `defineTypePack` accept seed upgrade
  baselines whose frontmatter uses YAML anchors. They now read only a starter's
  top-level `kind`, `name` and `version`, without alias expansion, instead of
  rejecting the whole document; TaskNotes' first task starter uses an anchor,
  so its `tasknotes.task` manifests failed validation.
