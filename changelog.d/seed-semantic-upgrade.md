## Fixed

- Upgrade an app's starter note types by content rather than exact bytes. A type that another writer re-serialised (sorted keys, expanded flow style or anchors) is recognised as the published version it matches, so it is current or upgrades normally.
- Upgrade starter note types in collections whose setup record has no origin for them, as older installers wrote. Setup merges against the published version nearest the live type and keeps the person's customisations, provided the result still implements what the app needs. This fixes TaskNotes setup stopping at "Setup can't finish" for such collections.
