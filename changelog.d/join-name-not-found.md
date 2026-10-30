## Fixed

- Joining a collection on another computer now names it as the account does, instead of after the local folder. A name given with `--name` still wins, and the folder name is used when the account only has the default name.
- Joining with an ID that matches no collection now reports `not_found`, instead of a sync refusal saying the collection is not a current cloud copy or private collection.
- Both join routes report the same `not_found` response for unknown collection IDs and collections without current membership, consistent with other collection routes.
