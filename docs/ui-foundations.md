# UI foundations

`@mdbase-dev/ui/dialog`: `Dialog({open, title, onClose, children})`. Native modal semantics, Escape/backdrop dismissal, focus return and exit retention. `closeDisabled` locks consequential pending work; `returnFocusRef` names a surviving invoker when a chooser's row disappears.

`@mdbase-dev/ui/confirm-dialog`: `ConfirmDialog({open, title, consequence?, confirmLabel, pendingLabel, onConfirm, onClose, children?})`. Cancel takes initial focus; an awaited callback keeps the modal pending. The caller closes only after acknowledged success. `disabled` gates validation and `busy` reflects externally owned work.

`@mdbase-dev/ui/menu`: `Menu({open, triggerRef, id, onClose, children})`; `onClose(refocus)` distinguishes Escape from an outside pointer. Existing menu item roles and arrow navigation remain.

`@mdbase-dev/ui/overlay`: `useOverlay<Element>(open)` returns `{ref, present}`. Render while present, put the ref and `mdbase-overlay` / `data-open={open}` on the transitioning node. CSS owns reversal; the node leaves after the exit duration. Motion, focus and palette geometry tokens have one definition. No data-screen entrance choreography is added.

## Editor publication boundary

The Editor still consumes an exact npm `@mdbase-dev/ui` pin. This PR does not substitute workspace source or adopt unavailable APIs. Its existing Dialog, ActionMenu, ContextMenu, QuickOpen and toast adapters must be migrated and their bespoke lifecycle/traps deleted in the repin follow-up; the Editor's palette/focus/type CSS must then consume these shared tokens too.

A merged app-ui change enters the existing **Publish npm packages** workflow (`.github/workflows/publish-npm.yml`) after successful Server CI on main, or its scheduled/manual reconciliation. `scripts/continuous-sdk-release.mjs plan workspace` detects changed public-package inputs (`scripts/public-packages.mjs` includes app-ui), requires qualified main and verified publication provenance, and checks production contract compatibility through `scripts/lib/continuous-client-release.mjs`. TS component changes are contract-sensitive under that conservative classifier: merge alone does not guarantee publication. The release owner must resolve any compatibility hold through the existing release process, not bypass it.

Once an exact version containing this commit is actually published with verified provenance, open a separate repin/adoption PR:

1. Take that exact published UI version and its canonical npm tarball integrity (not an assumed beta number or a dist-tag alone).
2. Update `apps/editor/package.json`'s exact `@mdbase-dev/ui` dependency, `config/native-publish/production.json` and `config/native-publish/staging.json` UI version/integrity together, following `apps/editor/NATIVE_PUBLISHER.md`; regenerate `pnpm-lock.yaml` with the normal install path. Preserve the SDK pins and source/tree identities.
3. Migrate the Editor adapters listed above to the published APIs and delete the replaced mechanisms, including manual dialog stacks/inert/focus traps. Verify both palette geometries against the shared tokens.
4. Run the native publisher pin tests, frozen install, Editor typecheck/unit/style gates and Playwright (including `tests/demo-smoke.spec.ts`), then the repository PR gates. Publication/deployment is separate release-owner work; this PR performs neither.
