## Fixed

- On Linux, the daemon's control socket is now always `~/.local/state/mdbase/run/control.sock`, so apps and terminals started without `XDG_RUNTIME_DIR` (or with a different one) still find a running daemon. A daemon still running from an earlier version is reachable again once it restarts.
- A keychain failure while authenticating a command is reported as `credential_store_unavailable` instead of `daemon_unreachable`.
- A second link request while another is waiting for confirmation is refused with `link_prompt_busy`, distinct from a declined link (`link_not_approved`).
- `mdbase collection join` accepts a folder that holds only hidden entries such as `.obsidian`; they are left as they are. A folder with an `.mdbase` directory is still refused.
- `mdbase conflicts` lists a collection's unresolved conflicts (record, path, kind and field) instead of reporting "not implemented".
- `mdbase sync enable` right after `mdbase collection add` waits briefly for the collection to finish opening instead of failing with `not_serving`.
- `mdbase status` stays fast while a collection ingests many changes: a busy collection reports its last counters (without digests) instead of holding up the answer.
