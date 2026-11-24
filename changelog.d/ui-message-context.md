## Fixed

- The filter builder, date picker and property list in `@mdbase-dev/ui` give every message a context, so their message IDs no longer match an app's own messages with the same English text ("Clear", "Back", "Done", "Filters", "Today" and others). When an app composed the shared catalogue with its own, one side's translations replaced the other's, and Reader's and TaskNotes' catalogue checks refused the update. Every translation is unchanged.
