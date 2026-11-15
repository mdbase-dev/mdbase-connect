## Fixed

- Editor publication checks the built `_headers` and `_redirects` against the candidate commit's copies, read through Git at the exact source SHA, so a reviewed change to them on main during a release no longer refuses the upload. Pre-upload and served-header checks use that same policy; any other hosting control is still refused.
