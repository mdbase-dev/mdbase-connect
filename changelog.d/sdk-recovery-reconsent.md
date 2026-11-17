## Fixed

- Turning on reminders for a collection after "Request access again" no longer
  stops the app with "Error code: binding". The collection's recovery asks
  again for that collection only, and Connect records the approval as exactly
  that collection with its reminder grant.
- Opening a collection again after a failed approval stopped the app no longer
  waits on "Opening…": the tab gets new ports for the collection.
