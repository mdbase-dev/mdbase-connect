## Changed

- Editor note-list search now asks the collection's full-text index which notes' text matches, instead of downloading every note's text first. Search in a large collection no longer waits for every note to load. Only the leading results are read, for their excerpts.
- Body matches are case-insensitive but no longer accent-insensitive. Words shorter than three characters match titles, paths and properties only. Quick open searches note text only when it is already loaded.
