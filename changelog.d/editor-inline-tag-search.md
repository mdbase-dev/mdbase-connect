## Fixed

- Editor: `#tag` and `tag:` searches and tag chip filters now find notes whose only tag is an inline `#tag` in the text. The collection answers them with its own `file.hasTag`, so a tag now matches in the case it is written, as the runtime's `hasTag` matches it. Tag suggestions still list only frontmatter tags.
