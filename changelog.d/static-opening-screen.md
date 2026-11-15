## Added

- Add `@mdbase-dev/ui/opening-page`, a Vite plugin that paints the shared opening screen from index.html before any script runs: the app's scanning mark, its name and what it is opening, with the saved theme applied, a reload hint after eight seconds, a notice when JavaScript is off, and the failure state when the app cannot start. `OpeningScreen` renders the same markup, so apps hand over to it without a visible change.
