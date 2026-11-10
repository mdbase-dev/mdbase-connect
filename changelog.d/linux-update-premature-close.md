## Fixed

- Desktop: a Linux self-update no longer fails with "Premature close" when `tar` finishes unpacking the package before its input has finished closing; `tar`'s exit code now decides whether the unpack worked.
