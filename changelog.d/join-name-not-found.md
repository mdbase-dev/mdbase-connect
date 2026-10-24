## Fixed

- Joining a collection on another computer now names it as the account does, instead of after the local folder. A name given with `--name` still wins, and the folder name is used when the account only has the default name.
- Joining with an ID that matches no collection now reports `not_found`, instead of a sync refusal saying the collection is not a current cloud copy or private collection.
- Joining a collection without current membership also reports `not_found`, so unknown and inaccessible collection IDs cannot be distinguished.
