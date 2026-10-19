## Changed

- Queue policy emission and recovery before database checkout when six policy
  owners are already active in this process. Reserve the other control-plane
  pool connections for foreground work, without rejecting queued policy work or
  releasing its admission before lock cleanup and physical connection release.
