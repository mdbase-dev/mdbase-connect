# mdbase

This plugin connects Claude to folders of markdown files that you approve in
mdbase connect. Once a collection is connected, Claude can find, read and
summarise its records, and create, update, rename or delete them if you allow
it. Each file is a record, and the fields in its frontmatter can be searched
and filtered. Changes are validated against the collection's type
definitions, and an edit is rejected if the record changed since it was read.
Each collection is approved separately with its own permissions. You can
remove access at any time in mdbase connect. The plugin can also help build
pages and small apps on top of a collection.

## Use it

1. Install the plugin and connect its mdbase connector.
2. Sign in to mdbase connect, choose one collection, and choose what Claude
   may do with it: read, create, edit, delete, or manage type definitions.
   Reading is required; the rest are optional.
3. Ask for what you need, for example "What tasks are due this week?" or
   "Add a reading-list entry for the book I just mentioned."

To use another collection, ask Claude to connect it and open the approval
link it gives you.

You need an mdbase connect account and at least one collection. A collection
kept only on your own devices is reachable while one of those devices is
online.

## What is included

- A connector to the mdbase gateway at `https://mcp.mdbase.dev/mcp`.
- The `mdbase-collections` skill, for working with records.
- The `mdbase-frontends` skill, for building pages and small apps on a
  collection.

The plugin contains no code. It runs nothing on your computer and has no
access to your local file system.

## Data

Tool calls and their results pass between Claude and the mdbase gateway at
`mcp.mdbase.dev`, and from there to the collection you approved. The plugin
sends data nowhere else.

The gateway stores the sign-in tokens and encrypted credentials for the
connection and, for each approved collection, its ID, display name and
approved operations. It does not store record contents, tool results or
record paths.

See the [privacy policy](https://mdbase.dev/privacy/) and the
[setup guide](https://mdbase.dev/apps/mcp/). For help, see
[support](https://mdbase.dev/support/).
