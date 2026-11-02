## Fixed

- The daemon no longer logs "hosted collection not joined yet" every 5 seconds while a captured hosted mirror waits for its collection. It logs once per join attempt, and attempts back off to every 30 minutes.
- `mdbase doctor` now warns about unsent edits from an old hosted mirror whose collection cannot be joined. The warning names the folder and the refusal reason. When the hosted collection is gone (`not_found`), it says the edits are still in the old folder, which mdbase never changes.
- The doctor takeover check now names each taken-over collection that is not registered yet, with its reason. For a folder refused because it contains, or sits inside, a registered collection, it lists the choices: leave it unserved, unregister the other collection, or move a folder, then run `mdbase migrate start`.
