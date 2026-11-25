## Fixed

- The Editor's tab strip follows the Editor's own light or dark theme. With the Editor set to light on a system in dark mode, the tab strip showed dark, with the active tab's title close to invisible; in dark mode it used the panels library's stock colours rather than the Editor's. The Editor now uses `@mdbase-dev/panels` 0.4.0, whose workspace takes its colours from an ancestor and follows the page's colour scheme.
