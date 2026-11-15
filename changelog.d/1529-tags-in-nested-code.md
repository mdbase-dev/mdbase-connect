## Fixed

- Keep `file.hasTag()` views working when a note spells a tag only inside code in a list item or block quote, or in indented code. The tag scan now follows list and quote nesting as Obsidian 1.12.7 does, so it skips that code and no longer mistakes indented list text for code. It still refuses where it can't tell what Obsidian would read. The stored tag projection rebuilds on upgrade.
