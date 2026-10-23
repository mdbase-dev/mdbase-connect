## Fixed

- Compile reviewed PO catalogues before direct UI, portal and desktop development, tests and typechecks; bootstrap the complete desktop workspace dependency graph for standalone packaging.
- Prune the bundled kit workspace link before Electron ASAR packaging, like the existing UI workspace inputs. Verify the native locale bundle runs independently of workspace packages and catalogue files.
- Run the i18n CLI without prebuilt kit output, preserve composition checks on Windows shells, and keep PO checkout line endings deterministic.
- Use the same Babel macro compiler for Vite and extraction so nested rich-text warnings render translated copy instead of raw message IDs in production.
- Include the language picker in the portal loading accessibility layout audit and wrap header controls at compact widths instead of overflowing.
