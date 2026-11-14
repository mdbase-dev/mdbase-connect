## Fixed

- App setup no longer stops on "Something went wrong" when a collection already has a plain file with exactly the bytes a managed setup file would write, such as the `_schemas/` files the TaskNotes plugin exports. Setup now replaces that file in the same change. A file with different contents still stops setup, now with an explanation that names the problem.
