## Security

- A computer waiting for approval of a Private collection no longer trusts the approving device as soon as it answers that device's challenge. The approver is kept as a trusted signer only when its key grant, sent after Allow, keys this computer for that same exchange. Expired, denied and renewed exchanges leave no trust behind (#1071).
- The comparison code on a computer waiting for Private approval comes back after a restart while the exchange is still live, so the codes can still be compared before Allow (#1072).
