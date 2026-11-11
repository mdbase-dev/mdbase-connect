## Changed

- Desktop catch-up commits the entries of each page it reads from the log as one durable SQLite commit instead of one per entry. The page is durable before anything acts on it (files written to the folder, appends, acknowledgements, notifications); policy, key and base items still commit durably one at a time. No stored or wire format changes; browser and hosted replicas are unchanged.
