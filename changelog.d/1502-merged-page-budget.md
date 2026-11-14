## Fixed

- End a path-ordered query page at the source budget, with a cursor, while a local write waits for the log. Writer's full-collection read of a library with large frontmatter no longer fails with `too_large` / `query_budget_exceeded` after a save.
