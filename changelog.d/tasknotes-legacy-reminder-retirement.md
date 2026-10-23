## Fixed

- Retire legacy TaskNotes reminders for the exact account, registered application UUID and collection after a successful native reminder reconciliation; keep legacy reminder delivery fenced independently of event retention. Preserve matching fired and overdue state without duplicate legacy delivery or historical backfill; current reminder membership still controls cancellation. Different manifest registrations with different application UUIDs are outside this retirement rule.
