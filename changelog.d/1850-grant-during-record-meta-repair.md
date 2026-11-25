## Fixed

- A cloud copy's hosted service now keys a newly enrolled device while it repairs record metadata after a type change, instead of after the whole repair. On large collections the repair advances one slice per second, so a first open in a new browser could wait several seconds or longer for its collection key.
