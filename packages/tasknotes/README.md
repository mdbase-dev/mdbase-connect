# @mdbase/tasknotes

Portable TaskNotes task semantics for mdbase connect clients. The adapter reads
the collection's `tasknotes.task` contract, follows its field-role mapping, and
performs revision-safe generic mdbase operations. It does not assume fixed
frontmatter property names or a fixed task type name.

The resolved contract includes JSON Schema field definitions, status and
priority vocabularies, collection path policy, capabilities, and all declared
TaskNotes field roles. `TasknotesCollection.refreshContract()` invalidates the
cached description after a type change. Creation applies declared defaults,
while completion uses `@tasknotes/model` for completed dates, recurrence, and
time-tracking effects. Unknown and unsupported frontmatter remains untouched.

`TasknotesOfflineCollection` provides the same contract-aware create, list, and
completion operations over an `@mdbase/connect-sync` offline replica. Local
changes appear immediately and retain their durable mutation IDs when the
replica later synchronizes with a hosted authority.
