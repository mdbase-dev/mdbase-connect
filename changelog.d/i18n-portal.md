## Added

- Translate the Connect portal, desktop menus/dialogs and shared interface controls into nine languages, with persisted language selection and deployment-local lazy catalogues.
- Validate every app/library catalogue composition without hiding conflicting shared translations; distinguish browser-session status and local-connection removal by semantic context.
- Exclude obsolete PO entries before catalogue compilation and rebuild checked shared UI catalogues before packing, preventing retired English messages from conflicting with application translations.
- Support localized command palette group headings through a presentation-only `groupLabel` callback, preserving stable group and `showAll` identifiers.
