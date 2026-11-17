## Fixed

- On touch screens, the shared Markdown live preview's controls (`@mdbase-dev/ui/live-preview`) take a 44px fingertip without growing visibly:
  - the table's row and column grips and its add-row and add-column strips;
  - a code block's Copy button;
  - a callout's fold button;
  - a diagram's Edit button.

  Their touch areas grow away from the table and the code, so they never cover more of the text than the controls already do. The shared checkbox and switch touch areas (`@mdbase-dev/ui` controls) now measure the full 44px; the checkbox's was 42px. Apps get this when they repin `@mdbase-dev/ui`.
