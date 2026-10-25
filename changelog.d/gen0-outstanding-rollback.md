## Fixed

- Allow operator rollback and managed route-back to cancel an outstanding generation-0 window or finish before base append, including fence-first runs still at `created`. Cancellation is atomic with rollback intent; fenced sources still require the existing source binding and receipt-qualified unfence.
