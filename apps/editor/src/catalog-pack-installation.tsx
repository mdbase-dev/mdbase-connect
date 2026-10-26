import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  CollectionDescription,
  TypePackAssessment,
  TypePackProvision
} from "@mdbase-dev/connect";
import type { ReactNode } from "react";
import {
  loadTypePackProvision,
  type ContractCatalogPack
} from "./contract-catalog";
import type { CollectionGateway } from "./model";

interface PackInstallConfirmation {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  initialFocus: "cancel";
  onConfirm: () => Promise<void>;
}

interface PackInstallCallbacks {
  installedTypeNames: string[];
  confirm: (confirmation: PackInstallConfirmation) => void;
  refreshDescription: () => Promise<CollectionDescription>;
  isTypeDraftDirty: () => boolean;
  openType: (name: string) => Promise<void>;
  notify: (message: string) => void;
  onError: (error: unknown) => void;
}

export async function reviewCatalogPackInstallation(
  pack: ContractCatalogPack,
  gateway: CollectionGateway,
  callbacks: PackInstallCallbacks
): Promise<void> {
  const provision = await loadTypePackProvision(pack);
  const assessment = await gateway.assessTypePack(provision);
  if (assessment.applicable) {
    await applyCatalogPack(pack, provision, assessment, {}, gateway, callbacks);
    return;
  }

  const conflicts = assessment.resources.filter(({ action }) => action === "conflict");
  const adoptable = conflicts.filter((resource) =>
    resource.mode === "managed" && resource.currentDigest && !resource.installedDigest);
  if (!adoptable.length || adoptable.length !== conflicts.length) {
    throw new Error(conflicts[0]?.reason ?? t`This pack conflicts with collection definitions.`);
  }

  const adoptions = Object.fromEntries(adoptable.map((resource) => [
    resource.target,
    resource.currentDigest!
  ]));
  callbacks.confirm({
    title: t`Let “${pack.displayName}” manage these definitions?`,
    body: <>
      <p><Trans>The collection has older unmanaged files at the pack’s managed paths.</Trans></p>
      <ul>{adoptable.map((resource) => <li key={resource.target}><code>{resource.target}</code></li>)}</ul>
      <p><Trans>The editor will replace these reviewed files and record their exact source, version, and digest in <code>mdbase.lock.yaml</code>. Future upgrades stop instead of overwriting an unexpected edit.</Trans></p>
    </>,
    confirmLabel: t`Adopt and update`,
    cancelLabel: t`Not now`,
    initialFocus: "cancel",
    onConfirm: async () => {
      try {
        const reviewed = await gateway.assessTypePack(provision, adoptions);
        if (!reviewed.applicable) {
          throw new Error(reviewed.resources.find(({ action }) => action === "conflict")?.reason
            ?? t`The definitions changed while they were being reviewed.`);
        }
        await applyCatalogPack(pack, provision, reviewed, adoptions, gateway, callbacks);
      } catch (error) {
        callbacks.onError(error);
      }
    }
  });
}

async function applyCatalogPack(
  pack: ContractCatalogPack,
  provision: TypePackProvision,
  assessment: TypePackAssessment,
  adoptions: Record<string, string>,
  gateway: CollectionGateway,
  callbacks: PackInstallCallbacks
): Promise<void> {
  const previousTypes = new Set(callbacks.installedTypeNames);
  const installed = await gateway.applyTypePack(provision, assessment, adoptions);
  const next = await callbacks.refreshDescription();
  const addedTypes = next.types.filter(({ name }) => !previousTypes.has(name));
  const primaryType = pack.primaryType
    ? addedTypes.find(({ name }) => name === pack.primaryType)
    : undefined;
  if (primaryType && !callbacks.isTypeDraftDirty()) {
    await callbacks.openType(primaryType.name);
    callbacks.notify(t`Added “${pack.displayName}” and opened the new type.`);
    return;
  }
  const packName = pack.displayName;
  const resourceCount = installed.resources.length;
  const newTypeCount = addedTypes.length;
  callbacks.notify(plural(newTypeCount, { one: `Installed “${packName}” (${resourceCount} resources, # new type).`, other: `Installed “${packName}” (${resourceCount} resources, # new types).` }));
}
