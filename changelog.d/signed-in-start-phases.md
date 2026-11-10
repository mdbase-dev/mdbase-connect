## Fixed

- A signed-in app no longer shows its collection chooser for a moment before opening the collection it was going to open anyway. The phase stays `starting` until the open begins (`startPending` in `ApplicationPhaseOptions`), so signed-in starts also record their `opening` and `total` startup measures.
- An app whose collection failed to open, for example because it was offline, opens it again when the app is shown again or comes back online. It used to stay on its opening screen until the page was reloaded.
