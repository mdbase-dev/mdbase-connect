## Changed

- Turning on sync now makes a cloud copy by default, including for folders that already have files. End-to-end encrypted Private sync moves under Advanced in the desktop app. Collections taken over from the previous connector stay Private.
- The portal no longer presents "Hosted by mdbase" as a separate kind of collection. New collections start with a cloud copy, and cloud copies are labelled the same way everywhere.
- Creating a collection while approving an app now uses the same retry-safe request as Add collection, so it also works for accounts on the new sync engine.
