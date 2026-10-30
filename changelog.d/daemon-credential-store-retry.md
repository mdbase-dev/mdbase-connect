## Fixed

- The daemon recovers when it starts before the OS credential store is unlocked, for example at boot. It retries the store when mdbase connect or the CLI next authenticates, so signing in no longer fails with "the control key is not loaded" until the daemon is restarted.
