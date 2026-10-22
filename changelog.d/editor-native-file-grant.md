## Fixed

- Use the SDK's native file grant for Editor attachment permissions, failing closed when the grant is unknown or lacks add permission.
- Upload through the original SDK file API and report success only after the original receipt and file readback match; keep the original mutation ID on uncertain or retired-scope outcomes.
