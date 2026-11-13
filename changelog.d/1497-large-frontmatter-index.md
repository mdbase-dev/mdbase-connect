## Fixed

- Open hosted collections whose records have a declared text field longer than an index key (8 KiB), such as long descriptions. That field is now left out of the browser query index instead of leaving the whole index unbuilt, which made opening a collection over about 1 MiB fail as too large.
- Name the cause when a hosted app is blocked as unavailable: the console line and problem detail now include the error class, typed code, the host step that refused, and for a failed device open the class of the underlying error.
