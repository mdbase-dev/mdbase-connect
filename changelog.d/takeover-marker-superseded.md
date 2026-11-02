## Fixed

- `mdbase doctor` no longer reports a permanent `marker_incident` failure for a taken-over folder that you unregistered and then registered again as a different collection. Registering a folder requires that no connector claims it, so the missing takeover claim is explained. The takeover clears the latched incident, and doctor stops failing. A taken-over folder that loses its claim in any other way still fails as before.
