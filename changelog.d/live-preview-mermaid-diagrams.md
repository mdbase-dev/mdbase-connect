## Added

- Render Mermaid diagrams in the shared Markdown live preview (`@mdbase-dev/ui/live-preview`) with Pele, the renderer Obsidian open-sourced. A top-level ` ```mermaid ` block shows as a themed diagram in light and dark mode and returns to its source when the caret enters it or **Edit** is pressed. Syntax errors show in place. Pele loads only when a note has a diagram, remote images in diagrams are off, and diagram links open in a new tab and never navigate the app.
