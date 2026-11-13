## Fixed

- Keep contract queries over more than one page working while a local write waits for the log. Writer's Sources and annotation index and Reader's library no longer fail with `upgrade_required` / `contract_query_cursor_required` after a save; a path-ordered query page now merges pending edits and still returns a cursor.
