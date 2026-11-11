## Fixed

- An app no longer opens a cloud copy from an empty replica. When a device's replica storage was lost after the collection had synced there, a start without Connect opened the empty store, so the app saw a collection with no records and could offer to set it up. Such a replica now catches up from the log like a first open, and a start without the network reports that the collection cannot be opened yet.
