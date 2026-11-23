## Added

- `@mdbase-dev/ui/filter-builder` exports `FilterBuilder`, an inline filter bar over a CEL `where` expression: pills for rules on a field or for raw expressions, in nested all, any and none groups. Styles are in `css/filter-builder.css`.
- `@mdbase-dev/ui/date-picker` exports `DateField` and `Calendar`: a date that opens a month to pick from, with a field that takes a typed day such as "tomorrow", "fri" or "+3". Styles are in `css/controls.css`.
- `@mdbase-dev/ui/combo` exports `Combo`, a text field with a list of plain values to choose from, or to add to from what was typed. Styles are in `css/controls.css`.
- `@mdbase-dev/ui/properties` exports `PropertyList`, a record's properties each edited in place with the control its value calls for, along with `propertiesInUse` and `filterFieldsFromProperties` to describe the properties a set of records holds. Styles are in `css/properties.css`.
- `@mdbase-dev/ui/anchored-popover` exports `AnchoredPopover`, the panel these open beside their control.
- `Menu` takes `align` to line up with the start of its trigger.
