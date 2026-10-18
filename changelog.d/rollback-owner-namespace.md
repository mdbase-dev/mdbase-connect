## Fixed

- Preserve the original Connect-owner migration rollback binding while qualifying the separate provider storage account. Receipts retain both identities atomically, and non-identity accounts can roll back without rewriting an existing intent. Deploy the provider migration and v2 routes before the control plane; the new control plane never falls back to v1. Existing UNKNOWN actions still require their original recovery flow.
