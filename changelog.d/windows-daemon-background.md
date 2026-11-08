## Fixed

- On Windows, `mdbase` now runs without the Visual C++ Redistributable, which fixes "mdbase paths failed (exit 3221225781)" at first launch of the desktop app.
- On Windows, the mdbase daemon now runs in the background instead of in a terminal window that stopped it when closed. Existing installs switch over the next time the desktop app starts or `mdbase service install` runs.
