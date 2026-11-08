## Fixed

- Release the file-upload lane when cancellation races commit, without discarding an already captured write, so Stop does not block the next upload.
