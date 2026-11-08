## Fixed

- Preserve the existing bounded local failure diagnostic when turning sync on stops at an incomplete source capture, so status and doctor can identify a known resource-ingestion refusal after the collection is paused or the daemon restarts. The capture safety fence and original files remain unchanged.
