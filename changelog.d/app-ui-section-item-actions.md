## Added

- `@mdbase-dev/ui/collections`: app section items take `actions`, shown in the same row menu as SDK collections, with danger styling for destructive ones. An action's `confirmDelete(onClose?)` opens `DeleteCollectionDialog` for the item, so an app can offer "Delete collection…" on its own collections with the usual typed-name confirmation. Closing a row dialog opened from the switcher returns focus to the switcher.
