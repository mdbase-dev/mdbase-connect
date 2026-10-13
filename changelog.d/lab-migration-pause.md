## Added

- LAB migration operators can request `lab-run --stop-before-flip` to pause after
  verified H1 and before native cutover preparation. `resume <account>` releases
  only the current paused native run through the authenticated operator entry;
  lost or drifted outcomes stop without retry. Requires compatible hosted Worker
  code; normal runs are unchanged.
