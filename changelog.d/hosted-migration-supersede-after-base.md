## Changed

- The hosted Worker refuses to supersede a rolled-back migration run (`migration_run_exists`, no change) when the target can no longer import generation 0 because the earlier run's base reached the log. Before, the fresh run fenced legacy, drained and then stopped at the generation-0 import.
