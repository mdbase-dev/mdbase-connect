## Changed

- mdbase connect for desktop no longer checks on mdbase every few seconds while
  its window is closed to the tray or it was started at login. It refreshes as
  soon as the window is shown again. The window also opens straight away instead
  of waiting for mdbase to be found, and shows "Checking connection" meanwhile.
