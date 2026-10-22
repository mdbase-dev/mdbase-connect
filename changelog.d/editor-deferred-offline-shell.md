## Changed

- The Editor now registers its offline-app service worker after it first becomes usable, instead of from the page head, so a first visit no longer installs and precaches the whole app while the collection is opening. The large-collection loading budget again measures a real first visit.
