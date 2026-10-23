## Added

- Add a browser-local interface language preference, generated-ID interface catalogues and strict translation validation to the Editor. Notes, collection paths, and protocol identifiers are unchanged.
- Validate both shared UI catalogues alongside the editor before builds, rejecting conflicting translations instead of silently overriding them. Use consistent named arguments across plural branches so Japanese/Korean other-only and Russian few/many forms retain the same interpolation contract.
