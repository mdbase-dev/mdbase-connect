## Changed

- After the desktop app takes over a collection from mdbase Connect, it turns on
  Private sync for it automatically, so apps that used the collection keep
  working without being approved again. Their grants carry over to the Private
  collection when it is created (or the next time such an app connects). Files
  are never changed by this; a failed attempt is retried when mdbase starts,
  after sign-in and on a backoff, and the app and `mdbase doctor` say what it is
  waiting for. Collections that were paused by hand stay paused until resumed.
