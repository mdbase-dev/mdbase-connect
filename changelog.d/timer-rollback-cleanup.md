## Added

- Each hosted timer import page now records which provider run imported which timers. In LAB, a claim-bound route deletes a rolled-back run's unchanged imported timers after a settled pre-cutover rollback, so a later run can import the collection again. Drifted rows, native timers and other runs' timers are never deleted.
