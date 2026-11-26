## Changed

- Added a direct Upload files action in the Editor's New menu, empty list state,
  and command palette, plus drag-and-drop file upload onto the notes and files
  list without editing a note.
- Resolved unique file basenames in Editor file embeds (such as `![[page.html]]`
  resolving to `Attachments/page.html`) and added full-path disambiguation hints
  and quick fixes when multiple files share a basename.
- Added a line-count summary and short diff preview to the Editor version
  history restore confirmation dialog.
- Exposed Note properties directly in the phone note header and moved it to the
  top of the phone note actions menu.
- Clarified the Editor Fields panel empty-fields disclosure (`Show N empty
  fields` / `Hide empty fields`) and surfaced empty declared nested object
  parts from the same disclosure.
- Updated the Editor's offline/waiting-for-sync save-state copy to state clearly
  that changes are saved on this device and will sync automatically when the
  connection returns.
