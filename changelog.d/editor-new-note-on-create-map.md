## Fixed

- Editor: a new note of a type that requires a field its own `lifecycle.on_create` sets (TaskNotes' task type and its created date, for example) no longer asks for that field when the type writes `on_create` as a single rule instead of a list. The note is written when its title is finished, and the runtime fills the field.
