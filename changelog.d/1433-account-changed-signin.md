## Fixed

- When an app's sign-in was started with a different mdbase account than the one now signed in to the browser, the approval page says so and what to do (switch back to that account, or cancel), instead of a generic error with a "Try again" that could not succeed. Cancelling there stops the app waiting at once, rather than after the request expires 10 minutes later.
