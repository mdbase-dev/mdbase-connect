## Added

- `@mdbase-dev/ui/collections` and `@mdbase-dev/ui/collections.css`: shared collection UI for apps built on the SDK front door, covering the collection switcher, adding a collection, the gate and blocked screens, sign-out and Manage access. It includes a headless `collectionView`, React components and `mountCollectionUi()` for hosts that don't use React. Problems appear with their fix inside them, collection names wrap instead of truncating, popup calls run inside the click, and the layout works by keyboard and at phone width. The SDK is an optional peer dependency.
