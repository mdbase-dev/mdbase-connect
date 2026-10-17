## Added

- The operator migration job (`next-migration-lab`) prints one `worker_timeline` JSON line on stdout each time the hosted Worker's migration status changes. The line has the time since the run started, the run state and reason, the native checkpoint step and the kind of the last prepared action. Rehearsal logs now show how long each step took. Polling and decisions are unchanged.
