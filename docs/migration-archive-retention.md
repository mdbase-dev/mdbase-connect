# Migration archive timing

The existing dedicated verifier admission wire remains the closed v4 object. New
admissions require integer `retention.days = 116`, GOVERNANCE mode, canonical UTC
millisecond timestamps and an exact expiry of original completion plus
10,022,400,000 milliseconds. Capture starts no later than the first source read;
original completion must be between start and start plus 86,400,000 milliseconds.
Longer captures are abandoned, not completed with a fabricated or shifted clock.
Original completion closes qualified source capture and final payload bytes before
expiry publication; no new source reads or captured payload bytes may be added
after that boundary.

Membership/source/archive identity, topology freeze, seven-day source freshness,
trusted database time and atomic batch locks remain required. Future source or
completion times refuse; the computed future expiry is permitted, not erasure
proof. Retry preserves original acceptance and completion times. A new SQL
constraint enforces elapsed timing for new rows; historical migrations are unchanged.
The constraint is NOT VALID so historical receipts remain untouched, rather than
being backfilled as new admissions. Historical 120-day receipts cannot satisfy
current admission/start claims. Explicit historical recovery is a separate workflow.

Before freezing source acquisition, run the existing bounded deletion-drain action
once. Record a conservative UTC anchor before invoking it and the actual capture
start; anchor-to-start and freeze-start-to-start must each be at most 24 hours.
Drain first, then freeze and capture; do not unfreeze an already frozen cohort to
obtain a drain result. There is no atomic all-database freeze requirement. Unknown,
nonempty or unready drain outcomes stop the procedure; never automatically retry
a mutation whose outcome is unknown. This is cleanup hygiene, not a reusable
absence receipt or a source-exclusion certificate. Frozen acceptance, revocation
and terminal account exclusion remain enforced by their existing mechanisms.

Every containing archived version must have the exact original completion-based
expiry, not its individual write time plus 116 days. Live retained record/file
history remains product data, not pending deletion merely because it is history.
There is no separate filtered-export requirement here. Suspension alone is not
terminal exclusion and changes neither deletion clocks nor ordinary access denial.

Partial/abandoned copies keep their original capture clock and inventory. They
cannot be copied again to reset retention. Actual removal of all containing versions
must be verified by expiry plus two days and original deletion acceptance plus
120 days, including queued/frozen deletion intents. Lifecycle eligibility, a future
expiry, a delete request, or current-key absence are not verified removal. Erasure
stays pending until actual removal is verified; native archive obligations are
independent. This 116-day legacy exception does not apply to routine new-system
backups: every routine tier is at most 29 days, with actual backup removal within
30 days of deletion, not 30 days after a later copy.

The timing function/codec does not authenticate signatures, qualified source capture,
provider retention/version coverage, restore readiness or actual removal. Dedicated
verifier authority, deployment qualification and separately scoped operation
permissions remain necessary. PostgreSQL qualification includes UTC/non-UTC DST,
millisecond boundaries, immutable historical rows and concurrent membership claims;
schema-only in-memory tests do not qualify these properties.
