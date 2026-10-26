## Changed

- The hosted Worker accepts a migration `run` with a new backup hold over a stored run that is stopped, fully rolled back and unfenced with nothing outstanding, when the control-plane start is strictly newer for the same collection, owner and target. The old native run and its actions are kept for audit. Any other run with a different hold still answers `migration_run_exists`.
