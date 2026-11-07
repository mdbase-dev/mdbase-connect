## Fixed

- Checking a large hosted file upload that had expired or been cancelled returned a temporary storage error on every try, so a device holding it never started the upload again. The status now reports the upload as expired or cancelled.
- Committing a file upload to a full hosted account or collection now answers with the quota error before copying and re-checking the file, so retrying while the account is full no longer reads the whole file each time.
