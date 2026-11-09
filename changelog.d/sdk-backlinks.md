## Added

- Replicas answer `backlinks`, so `client.backlinks()` lists the records that link to a record in pages from Core's link index. Links resolve the same way rename resolves them, local pending changes are included, and a replica without the method reports `upgrade_required` (`backlinks_unsupported`).
- Replicas answer `resolve_links`, so `client.resolveLinks(from, links)` resolves link occurrences written in a note, an unsaved draft included, with the same Core parsing and resolution as backlinks and rename. Ambiguous links carry their sorted candidate paths, and a replica without the method reports `upgrade_required` (`resolve_links_unsupported`).
