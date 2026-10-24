/**
 * `@mdbase-dev/ui/collections`: the shared collection screens. Import
 * `@mdbase-dev/ui/collections.css` once. The SDK (`createMdbase`) is a peer.
 */
export { CollectionGate, CollectionPanel, CollectionProblem } from "./collections/CollectionGate.js";
export type { AppCollectionContext, CollectionExtraActions, CollectionGateOwnProps, CollectionGateProps, CollectionPanelProps, CollectionProblemProps } from "./collections/CollectionGate.js";
export { CollectionSaveWarning, useCollectionSaveWarning } from "./collections/CollectionSaveWarning.js";
export { CollectionSwitcher } from "./collections/CollectionSwitcher.js";
export type { CollectionSwitcherProps } from "./collections/CollectionSwitcher.js";
export { SetupReview as CollectionSetupReview } from "./collections/SetupReview.js";
export { DeleteCollectionDialog, ForgetCollectionDialog } from "./collections/dialogs.js";
export { useAutoStart, useCollectionUi } from "./collections/use-collection-ui.js";
export type {
  CollectionActionName, CollectionActions, CollectionAppIdentity, CollectionSection, CollectionSectionItem, CollectionSectionItemAction,
  CollectionSectionItemActionContext, CollectionUi, CollectionUiOptions, DeleteCollectionOutcome,
  LeaveIntent, OpenSectionItem,
} from "./collections/use-collection-ui.js";
export { collectionView, collectionRows, problemControl, accountLabel } from "./collections/model.js";
export type { CollectionNotice, CollectionRole, CollectionRow, CollectionView, CollectionViewKind, CollectionViewOptions, ProblemControl } from "./collections/model.js";
export { defaultCollectionCopy } from "./collections/copy.js";
export type { CollectionCopy, CollectionCopyKey } from "./collections/copy.js";
export { mountCollectionUi } from "./collections/mount.js";
export type { CollectionUiPart, MountCollectionUiOptions, MountedCollectionUi } from "./collections/mount.js";
