## Fixed

- The Connect web portal no longer shows a second, page-level scrollbar beside its scrolling pane. The feedback provider's screen-reader status line sat one pixel below the full-height shell, which made the page 1px taller than the window. Visually hidden text (`.mdbase-visually-hidden`, `.mdbase-collections-visually-hidden`) no longer adds to a page's scrollable area in any app, and the duplicate `.mdbase-feedback-sr-only` class is removed in favour of `.mdbase-visually-hidden`.
