## Fixed

- Opening a note in a large collection no longer stalls the editor. Linked from asks the collection for backlinks instead of scanning every note body, so it no longer waits for note text to load.
- Links in the editor now go where the collection says they go. Following, previewing, embedding and checking a link use the collection's own resolution, so the editor no longer treats a note's title or alias as a link target that other mdbase apps would not follow. A link written as a title or alias is flagged, with a quick fix that rewrites it to the note's path, and an ambiguous link offers the notes it could mean.
