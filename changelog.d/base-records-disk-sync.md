## Fixed

- Files with a record extension other than Markdown, such as Obsidian `.base` views, now sync with disk in both directions in a collection served by the daemon or desktop app. Edits made on disk were ignored, and after one, app edits to that file never reached it, with no hold or conflict shown. If the app and the disk both changed a file, the daemon now shows a hold with both versions.
