## Fixed

- Explain when an owner must join a synced collection on this computer before
  deleting or renaming it, while preserving the device enrollment requirement.
- Add next runtime `mdbase collection delete <name-or-id> --confirm <shared-name>`
  through the signed-in daemon. Local files and registration are retained;
  `collection remove` continues to unregister only the local folder.
