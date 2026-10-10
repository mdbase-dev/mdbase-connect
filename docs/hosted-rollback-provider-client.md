# Internal hosted rollback receipt transport

`HostedProviderClient.legacyMigrationRollback` and
`legacyMigrationRollbackReceipt` use the provider-local atomic receipt endpoints.
These are transport methods only: no CP route, native admission/currentness
issuer, migration action dispatcher or rollback permission is added.

The caller must independently qualify the current CP started owner/source-target
claim and actual saved native RollingBack, pre-CutoverIntent, pending-action and
settled/ineligible competing-effects guards before a mutation. Recheck actual
context after awaits. The provider's dedicated internal authentication and locked
source guards do not prove globally atomic CP/provider currentness.

Both methods:
- refuse nil/noncanonical identifiers, duplicate or more than1000 replica IDs,
  nonpositive epochs, and counters outside nonnegative JavaScript safe integers;
- sort a parsed copy of replica scopes, preserving caller data;
- bound response bytes to128KiB before JSON parsing and require exact collection,
  owner/run/epoch/fixed-head/Driver/action/requested-scope binding;
- allow only distinct restored IDs within the exact requested scope;
- make one request through the existing provider transport, without automatic
  retry, restore fallback or active-only success inference.

Native u64 ABI counters remain canonical decimal strings. A future native bridge
must convert only exact safe-range values to provider JSON integers or refuse;
these methods do not add a rounding conversion or change the provider's i64 API.

A lost mutation response is UNKNOWN. An independently guarded read-only receipt
lookup uses the original durably saved binding. Preserve the full original
receipt before Driver completion clears IDs; a later Unfence action ID is not the
original restore action. Missing, malformed, oversized or different-binding
receipt evidence remains an error. Historical evidence is not fresh permission.

Existing nonrollback callers retain their bounded transient-retry behavior.
Source-only tests do not qualify native rollback, archive custody or operations.
