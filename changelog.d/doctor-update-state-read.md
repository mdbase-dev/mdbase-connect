## Changed

- `mdbase doctor` reads the Desktop app's update state off the daemon's async thread, only from a regular file of at most 64 KiB (not a symbolic link), and prints control characters from it as escapes. A file that does not meet these limits is reported as unreadable.
