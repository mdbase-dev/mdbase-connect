## Fixed

- Upgrading an edited seed type now writes each upgraded top-level setting with the app's published text instead of re-emitting it, so app-managed types keep their published flow lists, quoting and anchors and stay byte-stable for later upgrades.
