## Fixed

- Return a shorter page with a cursor when a paged query's records exceed the 1 MiB per-request source budget, instead of refusing it with `too_large`. Apps such as Writer could not load the index of a collection whose notes averaged more than about 2 KB.
