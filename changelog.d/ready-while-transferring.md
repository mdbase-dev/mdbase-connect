## Fixed

- Report a synced collection as `syncing`, not `ready`, in daemon status while it has unfinished sync work, including an inbound or outbound file transfer, so `ready` means the collection is complete on this computer (#1122).
