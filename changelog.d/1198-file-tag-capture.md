## Fixed

- Keep `file.hasTag()` views usable when a note's body has references such as `#16/#18` or URL fragments: `file.hasTag()` now answers for every name the body cannot contain and refuses only a tag spelled where the answer is still uncertain. Body tags now follow Obsidian's parsing, and the stored tag projection rebuilds on upgrade.
