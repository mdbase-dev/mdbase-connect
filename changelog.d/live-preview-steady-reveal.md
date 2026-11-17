## Fixed

- Showing Markdown syntax in the shared live preview (`@mdbase-dev/ui/live-preview`) no longer moves the text:
  - **Headings and quotes.** A heading's text used to move 7–9px right when its `#` showed, and a quote's text 4px. The revealed mark now hangs in the margin with its space.
  - **Opening fence.** Showing it moved the lines below up 2.6px. It now keeps the height of the header it replaces.
  - **Closing fence.** Showing it moved the lines below down 10.5px. While hidden, it now keeps its line, so a code block ends with the same space its header takes at the top.
- On phones, heading and quote marks still show inline, since there is no margin to hang them in.
- Apps get this when they repin `@mdbase-dev/ui`.
