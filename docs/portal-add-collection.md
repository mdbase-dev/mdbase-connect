# One Add collection entry

The collections page always offers **Add collection**. Its one location choice
lists **On this computer** when the current account owns a linked, non-revoked
Native desktop/CLI registration, and **Hosted** only when Hosted is enabled.
Another account's devices and application runtimes never enable Native creation.
With both choices available, the user chooses explicitly; the portal does not
silently switch authorities. With neither, it explains how to connect a computer.

Native uses the existing `mdbase-connect://open` desktop handoff. Folder selection,
collection keys and signed genesis remain on the device. The portal neither
creates a Native collection nor borrows Hosted credentials for it. Hosted keeps
its existing named-collection creation endpoint and failure recovery.

Native registry metadata alone is not serving-readiness evidence. Its collection
badge therefore says **Availability unknown**, not the registry's sync-kind
(Private/Cloud copy), without inventing an online/Effective state. Storage details
can still explain where the collection is configured to live. Application access
continues to require the application's original collection approval.
