## Fixed

- A hosted file upload whose commit was still finishing when the upload expired could be published after its status already said it had expired. By then a device may have started the upload again, so the file briefly showed as needing a decision. Status now marks such an upload expired before saying so, after any commit that is already publishing it, so a commit still copying can no longer publish afterwards.
