## Fixed

- A cloud copy's hosted service now applies up to 64 log items per catch-up step instead of 16, so it works through a large import in a quarter of the steps. A newly enrolled device's collection key is granted only after that catch-up, so a first open in a new browser soon after a large import waited for the whole backlog.
