## Changed

- A write that sets a path-stored field to a value mdbase has to make path-safe, such as a title containing `:` or `/`, now returns a `path_value_normalized` warning with the value as written and the value that was stored.
- Inline tags are read with the same code rules as links: a `#tag` inside a fenced code block or an inline code span is ignored exactly where a link would be, including in `~~~` fences and code spans delimited by several backticks.
