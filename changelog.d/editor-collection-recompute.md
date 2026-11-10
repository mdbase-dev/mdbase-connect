## Changed

- The Editor updates its note list once per batch of collection changes instead
  of once per changed note, no longer republishes the list when a save's note
  update is committed, and stops copying the whole list for every page of a
  collection's first load. Nothing shown changes; large collections do less work
  after saves and changes made elsewhere.
