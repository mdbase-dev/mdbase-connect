# Security policy

mdbase connect is prerelease software. Its security boundaries are actively
tested, but beta builds are not a substitute for a signed stable release. The
open stable-release gates are recorded in
[`config/release-readiness.json`](config/release-readiness.json). An independent
security audit is planned separately and is not a stable-release gate.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository. Include:

- the affected component and version or commit;
- the prerequisites and smallest reproducible sequence;
- the impact you observed or believe is possible;
- relevant logs or artifacts with credentials, collection paths, and record
  content removed; and
- whether you believe active exploitation is occurring.

Do not access data that is not yours, degrade a service, persist after proving
the issue, or publish details before a coordinated disclosure date.

The maintainer will acknowledge a complete report as soon as practical, assess
severity and affected versions, coordinate a fix and release, and credit the
reporter unless anonymity is requested. Response times are goals rather than a
service-level agreement while the project is maintained by a small team.

## Supported versions

Only the latest beta release and the current `main` branch receive security
fixes before `0.1.0`. Older beta artifacts are test builds and may be withdrawn
instead of patched. After a stable release, this section will list supported
release lines explicitly.

## Trust boundaries

The authoritative security model is documented in
[`docs/threat-model.md`](docs/threat-model.md). In particular:

- a local connector remains the final authority for a local collection;
- absolute local paths and collection payloads do not belong in the control
  plane;
- relay operation payloads are end-to-end encrypted;
- grants are exact, collection-scoped, and rechecked at the authority;
- hosted data is encrypted using per-collection data keys; and
- revocation must fail closed and survive process or provider outages.

Never include production credentials, data keys, OAuth tokens, record payloads,
or user collection paths in a vulnerability report, test fixture, issue, or
log excerpt.
