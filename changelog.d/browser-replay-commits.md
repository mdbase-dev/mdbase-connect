## Changed

- The browser and mobile app runtime now commits each caught-up page of log entries to its local database once, instead of once per entry, using the same deferred-durability window as desktop catch-up. The first open of a cloud collection in a new browser replays its log several times faster; a tab or Worker closed during the catch-up reopens at the last committed page and finishes from there.
