## Fixed

- Saved-view discovery no longer fails with `conflict` (`concurrent_modification`) when the collection holds a note between 512 KiB and 1 MiB. Any record that fits a 1 MiB discovery page is now read and classified; only a Base must still fit within half a page, and one that doesn't is refused as a named budget limit (tasknotes-app#436).
