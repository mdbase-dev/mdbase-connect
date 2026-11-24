## Fixed

- Install ready-made type packs into collections whose types and contracts live in configured folders such as `_mdbase/types` and `_mdbase/contracts`. Type pack plans without caller target overrides now use the same target decision as collection setup, so the Editor and other SDK callers no longer try to write `_contracts/…` paths those collections cannot hold (#1893).
