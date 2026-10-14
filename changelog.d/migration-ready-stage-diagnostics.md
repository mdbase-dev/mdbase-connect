## Fixed

- Preserve finite Worker readiness stage, error name and detail code before migration status reconciliation. Unknown values stay `unknown`/`other`, unrelated replies stay null, and HTTP500 remains UNKNOWN without retry or raw error output.
