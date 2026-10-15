## Fixed

- Make the cold-runtime shutdown regression synchronize on the actual opener, and account for Windows' existing per-folder delete-share cleanup budget without changing shutdown behavior.
