## Added

- A LAB-only operator command, `next-migration-lab`, runs one tiny fixture account's hosted migration end to end (`lab-run`) or routes it back before cutover (`route-back`). It stops for an operator on any unknown outcome and prints the step, the reason code and the commands to inspect and resume. See docs/lab-migration-run.md.
