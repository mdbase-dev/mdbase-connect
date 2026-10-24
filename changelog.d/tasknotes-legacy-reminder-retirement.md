## Fixed

- Retire legacy TaskNotes reminders for the exact account, TaskNotes application family and collection across versioned registrations after a successful native reminder reconciliation. Fence legacy `task.reminder` delivery across namespaces independently of event retention. Preserve matching fired and overdue state without duplicate legacy delivery or historical backfill; current reminder membership still controls cancellation. Native grants remain independently scheduled.
