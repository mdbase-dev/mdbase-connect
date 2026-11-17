## Fixed

- Down in the shared Markdown live preview (`@mdbase-dev/ui/live-preview`) now visits each line of a table cell whose text wraps, as Up does. It used to leave the row from the cell's first line whenever the row's last cell was shorter, skipping the rest of the cell. Apps get this when they repin `@mdbase-dev/ui`.
