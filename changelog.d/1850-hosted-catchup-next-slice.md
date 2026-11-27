## Fixed

- A cloud copy's hosted service now catches up with a log backlog one slice straight after another, instead of one slice per second. A newly enrolled device's collection key is granted only after that catch-up, so a first open in a new browser soon after a large import could wait a minute or more for its key.
