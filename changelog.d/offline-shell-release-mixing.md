## Fixed

- After a deploy, apps using the SDK offline shell no longer load the new release's page against the previous release's stylesheets and SDK, which could show unstyled headings, bordered menus or old SDK behaviour. A navigation to an app page is answered from the release that controls the tab, and a newly installed release is activated when the app next starts, with one reload. Editor does the same at startup.
