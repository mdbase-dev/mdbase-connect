## Fixed

- The hosted MCP gateway can be approved for collections on the updated mdbase
  again: it now requests the file access that read and write approval requires.
  Read-only connections request only listing and reading files. Collections
  whose MCP approval predates the update now return `reconnect_required` with
  a re-approval link, instead of a message asking the user to reload a page.
