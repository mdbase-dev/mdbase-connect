## Changed

- Saved-view discovery classifies up to the request's whole source budget (1000 records, 1 MiB) per page instead of half of it. Only a record that is a Base is read a second time to confirm the page, and a page ends before a Base whose second read would not fit. Discovery reads every record, and on a Private collection each page is a round trip through the relay to the computer that holds it, so a large vault of notes needs about half as many round trips.
