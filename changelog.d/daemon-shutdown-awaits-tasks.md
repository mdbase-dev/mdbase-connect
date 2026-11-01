## Fixed

- The daemon now aborts and waits for every task it started before shutdown returns, including takeover retries, Private sync turn-on passes and the blocking takeover work. Previously these could still write to the profile directory after the daemon stopped (#1089).
