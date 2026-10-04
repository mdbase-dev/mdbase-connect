## Added

- The editor can run on the mdbase-next replica client API (`@mdbase-dev/sdk`) as an
  opt-in backend: `?backend=next-demo` uses an in-memory replica with sample notes,
  and `?backend=next` connects through the relay once the control plane can issue
  grants and routes. The note list is a windowed live query without bodies that
  widens as you scroll, a note's body is read when it opens, and edits show as
  waiting to sync until the replica confirms them. Connect remains the default.
