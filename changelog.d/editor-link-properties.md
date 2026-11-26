## Added

- Editor: "Link" is a field type in the type editor. Choosing it writes the field and its link rule together, with the types it may point at, whether it holds several links, and the link format. The separate "Links" list under Collection behaviour is gone; rules on values the field list does not show stay editable in YAML.
- Editor: a link property is edited as links in the properties panel: each one a chip that opens its note, with a picker that finds a note of the property's type or creates one from the typed name.
- Editor: `[[` and `@` suggestions offer to create the note being linked to, as a plain note or as any of the collection's types, without leaving the note being written.
- Editor: creating a note while linking asks for what its type requires. A type that needs more than a name opens a short form beside the link, with the name and the required properties only; confirming it creates the note and writes the link.
- Editor: "Linked from" groups backlinks by the type of the linking note and names the property a link is held in.
