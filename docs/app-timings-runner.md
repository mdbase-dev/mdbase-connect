# Dedicated synthetic timing runner

The app timings suite runs on a dedicated Compute Engine VM, separate from all
agent desks and the minipc. Infrastructure uses project `mdbase-connect`, zone
`us-central1-a`, machine `e2-standard-2`, an Ubuntu 24.04 boot image, one 10 GB
`pd-balanced` boot disk and an ephemeral external IPv4 address. There is no VM
service account and no cloud scope. No credentials go in instance metadata.
Ubuntu 24.04 is required by the published CLI's glibc baseline; Debian 12 cannot
run that release. No installed personal daemon is involved.

## Provision and daily operation

Substitute the owned runner and schedule names in these commands. The Compute
Engine API and billing must be enabled. Keep the existing default VPC; do not
create firewall rules or expose browser/debugging ports.

```sh
gcloud compute resource-policies create instance-schedule "$schedule" \
  --project=mdbase-connect --region=us-central1 \
  --vm-start-schedule='30 16 * * *' --vm-stop-schedule='0 17 * * *' \
  --timezone=Etc/UTC
gcloud compute instances create "$runner" \
  --project=mdbase-connect --zone=us-central1-a \
  --machine-type=e2-standard-2 --boot-disk-size=10GB --boot-disk-type=pd-balanced \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --no-service-account --no-scopes --resource-policies="$schedule"
```

Grant the project's Compute Engine service agent `roles/compute.instanceAdmin.v1`
**on this instance only** using `gcloud compute instances add-iam-policy-binding`.
This lets the instance schedule start/stop its VM without project-wide instance
administration. Inspect the attached policy and its UTC start/stop cron fields.
A start-only schedule is incomplete.

Install Node 24, the exact Playwright version pinned in the repo, and Chromium's
OS dependencies and browser (`playwright install-deps chromium` then
`playwright install chromium`). Copy `run.mjs` and `results.mjs` from
`scripts/app-timings/` into `/opt/app-timings/`, install `@playwright/test` at the
same version, and run as an unprivileged runner user. Browser files must be
installed for that same user. No browser workload runs on the minipc.

Copy the saved portal session, corpus config and timings bearer file over SSH
with scp; ensure the directory is 0700 and private files are 0600. The source
registry, passwords and corpus IDs stay private. The config file is documented
in `app-timings.md`. Do not put secrets in shell arguments, logs, metadata or git.

Install the service after fixture qualification:

```sh
sudo sh scripts/app-timings/install-service.sh <runner-user>
```

The service starts on boot after networking, runs one suite, and powers the VM
off whether the suite succeeds or fails. `TimeoutStartSec=24min` caps a hung run
and also executes the poweroff hook. There is no restart policy. The independent
17:00 UTC instance stop is the backstop if the service or guest fails.
Before the first daily run, validate the unit with `systemd-analyze verify`,
verify the schedule has both actions, and test an actual scheduled stop. Confirm
Compute Engine reports `TERMINATED`; an SSH disconnect alone is not stop proof.
Restore the daily 16:30/17:00 cron after any temporary schedule test.

A 30-minute daily window is about 15 VM hours/month: roughly $1.01 compute at
$0.067/hour, $1 for 10 GB balanced disk, and $0.08 for active external IPv4 at
$0.005/hour (before tax/egress). Approximate total $2.10/month. Scheduled actions
can be delayed; the guest's 24-minute timeout bounds normal late starts. Check
actual run duration, stop status and billing after the first week.

## Fixture preparation and credentials

Use the registered `prod-big` account alias and retain only the three synthetic
fixtures. All resources are named with `[test] <run_id>`. The initial seeder used
the checksum-verified published Linux x64 CLI, an isolated state directory and
an unlocked Secret Service on this VM. Pair the computer through the public
Connect portal using the registered account, with daemon and CLI on the same
D-Bus session. Never print sign-in URLs, cookies, secrets or account identifiers.
Do not delete daemon state to repair a locked keyring.

Seed 100, 1,000 and 10,000 Markdown notes, each with explicit types
`[task, writer-manuscript]`, a synthetic title/body, `status: open`,
`priority: normal` and `due: 2026-01-01`. The fixed overdue date keeps tasks on
Today without daily corpus mutation. Provision each app's type/contract/schema
documents byte for byte from its served `/.well-known/mdbase-app.json` resource
provisions, refusing to overwrite a differing existing definition. This is
fixture data, not an alternate implementation of collection semantics.

Finish ordinary app setup before timed visits. Verify all three native copies
are ready with zero pending writes, holds or unresolved conflicts. Confirm
record counts, sign the seeder out, stop it and verify its owned registration is
revoked before measuring so indexing/sync does not consume benchmark CPU.
Preserve the fixtures and private ledger; never delete shared accounts or other
lanes' fixtures. Dedicated corpus definitions mean the counts are approximately
100/1k/10k notes plus a small number of type and contract records.

The runner reuses the saved portal session between days. If it expires, results
say `auth_expired`; renew that alias's portal session outside the timed run.
No password is stored in the suite config. A cleanup failure requires disabling
the daily service/schedule until the private installation ledger has been
reconciled. Ingestion failure leaves `latest.json` on disk; inspect only the
sanitized report, never credential or storage dumps.

To update the suite, stop the VM's scheduled run, copy reviewed source via SSH,
record its git head and script hashes privately, and retain the existing session,
token, configuration and corpus IDs. Do not overwrite a running installation.
