## Fixed

- Up and Down in the shared Markdown live preview (`@mdbase-dev/ui/live-preview`) reach every line that shows. They used to jump over tables (Down from the line above went past the whole table), code fences, display formulas and other rendered blocks. Now Down enters a table in the cell under the caret and moves row by row, and arrowing onto a rendered block shows its source. A caret arriving at a table row's start goes into its first cell, not before the hidden pipe. Apps get this when they repin `@mdbase-dev/ui`.
