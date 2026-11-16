## Fixed

- Typing inside a line of prose in the shared Markdown live preview (`@mdbase-dev/ui/live-preview`) no longer re-scans the whole note for code blocks, callouts, footnotes and math: it moves what it already found. A keystroke in a 300 KB note goes from about 5–8 ms to 1.5 ms of live-preview state work. Table editing no longer reads the page selection, which forces a layout, on keystrokes outside a table. Apps get this when they repin `@mdbase-dev/ui`.
