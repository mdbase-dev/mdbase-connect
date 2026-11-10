## Changed

- Checking a local folder for changes does less work per file on Linux and macOS. A scan of a folder in which nothing changed used to resolve every file's path from the collection folder again (one directory open per path segment) and run one database statement per file; it now takes each file's metadata through the directory handle the folder is listed with, so one more unchanged file costs one metadata lookup and nothing else. Which files are read, admitted and refused is unchanged, and Windows scans as before.
- Opening a collection that is already on the device reads each record from the local database once instead of three times while it compares the database with the folder.
