## Fixed

- Read minute-precision times such as `2025-10-06T22:32` and `2025-10-06 22:32` in Bases `date()` and in date-typed properties. One such value no longer refuses a whole view, such as TaskNotes' Today. Times with a fraction but no offset, a space before `Z` or an offset, and `±HHMM` offsets now parse too. Lowercase `t` and `z` now refuse, because Obsidian 1.12.7 doesn't read them as dates.
