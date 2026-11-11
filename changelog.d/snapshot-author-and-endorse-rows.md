## Security

- Only a device with write authority can author a snapshot that other replicas install: a keyed device of an editor or owner, or the hosted replica in a cloud copy, judged by the policy at the snapshot's position. A read-only member's device no longer builds snapshots, and replicas refuse to install or endorse one it signed.
- A replica now endorses a snapshot only after reading every chunk with the installer's own decoding and finding each row equal to its own, including document text, positions, capture times and receipts, which the state digest does not cover. Nothing in a shipped build endorses or compacts yet; this makes the check sound before it is switched on.
