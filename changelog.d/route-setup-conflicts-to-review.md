## Fixed

- Route non-`installed_newer` collection setup conflicts (such as an existing unmanaged `_types/task.md` or conflicting `_contracts/...` file) into the setup review flow instead of trapping the collection on `"Settings changed elsewhere"` (`configuration_conflict`) with only `"Try again"`.
- Show each conflicting target path in `SetupReview` so users can see which file conflicted when choosing whether to adopt the app's version or resolving non-adoptable conflicts.
