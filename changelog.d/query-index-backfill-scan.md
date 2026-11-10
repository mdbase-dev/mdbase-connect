## Fixed

- Rebuilding the query index no longer asks the store to rescan the whole
  index for orphaned rows on every 16-record page. The skip used to depend on
  how each SQLite engine (desktop, hosted, app) planned one statement; it is
  now decided before the statement is sent.
- The desktop and daemon SQLite index keeps up to 128 prepared statements
  instead of 16, so an edit followed by a query no longer re-prepares each of
  its roughly 54 statements every time.
