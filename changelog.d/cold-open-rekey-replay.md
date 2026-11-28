## Fixed

- Cold opens reuse a later device grant across key rotations during snapshot replay, avoiding repeated key waits and control-log reads.
