## Added

- `@mdbase-dev/ui/link-picker` exports `LinkPicker`, a text field that finds a record to link to or makes a new one of a given kind from the typed title. Apps supply the matches and the kinds that can be created; styles are in `css/controls.css`.
- `@mdbase-dev/ui/quick-create` exports `QuickCreate`, a short form that opens beside the place a record is made from: its name, then the fields the app supplies. It takes the keyboard until it is submitted or dismissed; styles are in `css/controls.css`.
- `useSelectPopover` takes `focusList: false` for a list that follows a text field, and a `contentKey` that places the list again when its rows change.
