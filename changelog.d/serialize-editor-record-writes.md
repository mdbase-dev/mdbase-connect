## Fixed

- Serialize concurrent record writes in the Editor's native record adapter instead of rejecting the second write as busy, so a host note's autosave after "Create and link" waits for the newly created target record instead of failing with "Your previous change is still being saved."
