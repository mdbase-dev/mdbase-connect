## Added

- Answer lower-cased note body searches (`file.body.lower().contains("...")`) from a full-text index in the runtime's SQLite store instead of reading every note. Searches of three or more characters are indexed. Shorter searches, and searches the index cannot answer exactly (some Greek final-sigma and NUL cases), still read each note. A note whose body is over 1 MiB leaves bodies out of that collection's index until it shrinks.
