## Added

- `@mdbase-dev/ui/collections`: `CollectionSwitcher` takes `open` and
  `onOpenChange` so an app can control it, and `variant="none"` with a
  required `anchorRef` renders no trigger, so an app can open the switcher
  from its own control, such as an item in its overflow menu. The
  wide-screen popover is placed against `anchorRef`, and closing the
  switcher, or a row dialog opened from it, returns focus there.
  `mountCollectionUi` does not accept `variant="none"`.
