## Changed

- When an app sets up or changes its types, a device catching up on a collection now does less work: it rewrites only the notes the change affects (none for a schema-only change) and rebuilds the query index in a single pass.
