## Added

- Migration-token routes `…/rollback` and `…/rollback-receipt` in front of the hosted provider's receipted pre-cutover rollback. Both are bound to the current migration claim, the collection's authority epoch and the exact rollback binding Connect records before the first dispatch, and return the provider receipt only after verifying that it echoes that binding. A receipted rollback also settles the LAB timer rollback cleanup.
