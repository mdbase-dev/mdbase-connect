## Fixed

- Feedback submissions now strip browser-emitted PNG metadata chunks (`eXIf`, `iTXt`, `tEXt`, `zTXt`, `iDOT`) and JPEG EXIF/IPTC/comment segments instead of rejecting valid screenshots, accept JPEG ICC color profiles, compress or downscale high-resolution screenshots to fit the 3 MB attachment limit, and resend the feedback text without the screenshot if an attachment is still rejected.
