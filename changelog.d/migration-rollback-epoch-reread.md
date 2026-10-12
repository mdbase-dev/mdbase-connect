## Changed

- The migration rollback and rollback-receipt routes accept an optional `authority_epoch` only when re-reading a recorded rollback; it must equal that original binding's epoch. A fresh rollback still takes the epoch from the collection's current binding and refuses a caller-supplied one.
