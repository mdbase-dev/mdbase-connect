## Changed

- The hosted MCP gateway now sends server instructions, and its tool descriptions say when to use each tool and what it changes, so assistants without the mdbase plugin skill confirm before deleting records or changing a type, offer `add_connection` for a collection that is not connected, and report saved paths.
- `update_record` and `update_type` are now marked destructive, so hosts such as ChatGPT ask before running them. Every gateway tool now declares all three safety hints explicitly.
