## Fixed

- An approval that grants reminders for the collection already open now gives
  that open collection `timers` without a page reload. Each tab showing it gets
  a new `phase.connection` onto the same open replica, and `subscribe` listeners
  are called. The collection is not reopened and pending writes are kept. An
  approval that leaves the reminder consent unchanged keeps the same connection.
