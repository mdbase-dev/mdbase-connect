## Added

- The operator migration job (`next-migration-lab`) now runs in a staging deployment as well as LAB. It reads the environment from the deployment's own configuration, uses that deployment's canonical Connect origin, requires the ordinary archived start in staging and flips and cleans up timers as staging. Production and local deployments are still refused, and the timer rollback-cleanup HTTP route stays LAB-only.
