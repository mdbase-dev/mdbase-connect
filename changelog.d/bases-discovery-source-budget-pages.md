## Changed

- Saved-view discovery reads up to 500 records per page, bounded by the request's source budget, instead of 64. On a Private collection each page is a round trip through the relay to the computer that holds it, so an app listing the views of a 765-record collection now waits for 2 round trips instead of 14. A page still reads every record and keeps the same continuation, fences and wire format.
