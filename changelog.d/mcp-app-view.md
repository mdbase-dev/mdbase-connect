## Added

- The hosted MCP gateway is now an MCP App. In Claude and other hosts that support MCP Apps, `query_records` results appear as a table of records and `read_record` and the record write tools show the record as a card, with its properties, its type's fields and its body rendered as in the Editor. Records open from the table, further pages load in place, and properties can be edited in place on connections approved to update records; each edit is checked against the record's revision.
- `update_record` takes `unset` to remove frontmatter fields.
- `@mdbase-dev/ui/properties` exports `propertiesFromSchema` and `mergeTypeSchemas`, which describe a record's properties for `PropertyList` from its types' JSON Schemas.
