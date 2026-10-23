# Managed whole-account migration

Implementation and qualification are in progress for beta.142. This contract is
not a claim that the current managed driver supports multiple collections.

The managed driver must bind the complete, sorted, distinct set of currently
held hosted collections (all owned hosted rows except `transferred`). An
importing, transferring, quarantined, deleting, or otherwise ineligible held
member blocks the account rather than disappearing from its inventory.
Transferred rows remain history; they are not new hosted migration work.

Every held collection must have its target prepared, its original Worker run
confirmed, its cutover recorded, and its timers verified. Only then may the
account flip once, using the exact complete array and combined cutover evidence.
A failure or unknown result for any member must not flip the account.

Resume must preserve successful per-collection progress and reconcile the same
original run before continuing; it must not recreate an ambiguous run. Status
and route-back must address the whole held set explicitly. LAB fixture singleton
contracts remain separate from ordinary managed account execution.

Qualification must cover two active collections, transferred history, an
all-transferred account, partial failure and resume, subset/duplicate refusal,
and the 16/17 collection boundary through the real product adapter.
