## Fixed

- Re-arm one coalesced service activation wake in `PolicyEmitter` when a newer policy batch commits while an earlier wake for the same collection is already in flight, and serialize hosted-worker open/refresh sync turns so overlapping `/v1/hosted/activate` wakes cannot abort an in-flight warm-wake key rebuild and stall key grants until the 30 s refresh alarm.
