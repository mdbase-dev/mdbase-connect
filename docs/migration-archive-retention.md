# Migration archive timing

The existing dedicated verifier admission wire remains the closed v4 object. New
admissions require integer `retention.days = 116`, GOVERNANCE mode, canonical UTC
millisecond timestamps and an exact expiry of original completion plus
10,022,400,000 milliseconds. Capture starts no later than the first source read;
original completion must be between start and start plus 86,400,000 milliseconds.
Longer captures are abandoned, not completed with a fabricated or shifted clock.

Membership/source/archive identity, topology freeze, seven-day source freshness,
trusted database time and atomic batch locks remain required. Future source or
completion times refuse; the computed future expiry is permitted, not erasure
proof. Retry preserves original acceptance and completion times. A new SQL
constraint enforces elapsed timing for new rows; historical migrations are unchanged.
The constraint is NOT VALID so historical receipts remain untouched, rather than
being backfilled as new admissions. Historical 120-day receipts cannot satisfy
current admission/start claims. Explicit historical recovery is a separate workflow.

Every containing archived version must have the exact original completion-based
expiry, not its individual write time plus 116 days. Producer/verifier qualification
must establish exclusion of previously deleted and terminally excluded content,
including retained histories, before capture. Suspension alone is not terminal
exclusion and does not change deletion clocks or ordinary access denial.

Partial/abandoned copies keep their original capture clock and inventory. They
cannot be copied again to reset retention. Actual removal of all containing versions
must be verified by expiry plus three days and original deletion acceptance plus
120 days, including queued/frozen deletion intents. Lifecycle eligibility, a future
expiry, a delete request, or current-key absence are not verified removal. Erasure
stays pending until actual all-version verification; native archive obligations are
independent.

The timing function/codec does not authenticate signatures, source omission,
provider retention/version coverage, restore readiness or actual removal. Dedicated
verifier authority, deployment qualification and separately scoped operation
permissions remain necessary. PostgreSQL qualification includes UTC/non-UTC DST,
millisecond boundaries, immutable historical rows and concurrent membership claims;
schema-only in-memory tests do not qualify these properties.
