## Fixed

- Open large collections in seconds after a restart instead of minutes. A note the Bases index cannot hold, such as one with broken frontmatter, no longer makes every open rebuild the whole query index; rebuilding the index is no longer quadratic in the number of notes, and the computer app's index rebuilds now write to disk once rather than once per page.
