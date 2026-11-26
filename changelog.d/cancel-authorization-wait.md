## Fixed

- Apps can leave the "Continue in the mdbase window" screen at any time. A new
  SDK call, `mdbase.cancelAuthorization()`, stops waiting for Connect: the app
  is signed out again, or returns to the collection list when signed in, and a
  reload no longer resumes the abandoned sign-in. Apps with work before
  connecting return to that work. The shared collection screens show a
  "Continue without connecting" button there (or "Cancel" when signed in).
  Before, its Cancel button disappeared soon after the window opened, and
  a reload during sign-in left the app on that screen until the request expired.
