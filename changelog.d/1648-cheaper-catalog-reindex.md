## Changed

- Large collections open faster after an app sets up or changes its types: a device now rewrites only the notes a type change affects (none for a schema-only change) and rebuilds the query index in the same single pass.
