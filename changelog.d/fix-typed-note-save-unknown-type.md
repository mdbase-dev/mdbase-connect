## Fixed

- Allow saving notes whose `type:` frontmatter names a type not defined in the
  collection's types folder, reporting `unknown_type` as a non-blocking warning
  instead of rejecting writes.
- Include validation issue field locations in rejected write problems and show
  the specific refusal reason in the Editor's inline save notice whenever a
  write is refused.
