## Fixed

- Explain when an owner must join a synced collection on this computer before
  deleting or renaming it, while preserving the device enrollment requirement.
- Preserve the SDK's collection approval outcome for an unjoined installation device.
- Add next runtime `mdbase collection delete <name-or-id> --confirm <shared-name>`
  through the signed-in daemon with control-key authentication. Local files and
  registration are retained; the success message points to `collection remove`
  to unregister the local folder. Network failures and malformed deletion replies
  report an unknown outcome, and acknowledged deletion appears in local activity.
