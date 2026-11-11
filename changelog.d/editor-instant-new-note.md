## Changed

- Editor: a new note opens straight in the editor, with the cursor in its title. There is no creation form, Create button or Cancel: the note is written when the title is finished with Enter or Tab, or when writing starts in the body, and from then on it saves like any other note. A note nothing was written in is dropped when it is left.
- Editor: a note started without a title is written as `Untitled.md` and its file is named once, from the first title it is given. Later title changes leave the file name alone; Rename and Move still change it.
- Editor: a new note takes its folder, tag and type from the list being looked at, and shows where it will be written in the top bar. Fields its type requires appear under the title, except those the type fills itself when the note is created (a task's created date, for example); until they are filled the note waits in the list as "Not saved yet" instead of asking whether to discard it.
- Editor: Shift+C, the arrow beside New note and the "New note of type…" action choose a type for the new note, and each type has its own "New …" action in the command palette. Quick open offers "Create note" for any search that is not already a note's title, and creates it under that name at once.
- Editor: New folder asks for the folder's name in the sidebar and opens a new note in it, replacing the New folder form. The folder exists once that note is written.
- Editor: Enter in a note's title moves to the body. The Ctrl+Enter "Create note" shortcut is removed with the form it submitted.
