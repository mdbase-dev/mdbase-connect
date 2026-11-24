## Changed

- A device catching up on a collection now builds its query index once, after the last entry it is reading, instead of after the snapshot and again after each type change on the way. Until then its queries read the notes directly, so they are slower, and on the web a query over a large collection can be refused until the index is built.
