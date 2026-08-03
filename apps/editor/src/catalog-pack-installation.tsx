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
    resource.mode === "managed" && resource.current_digest && !resource.installed_digest);
  if (!adoptable.length || adoptable.length !== conflicts.length) {
    throw new Error(conflicts[0]?.reason ?? "This pack conflicts with collection definitions.");
  }

  const adoptions = Object.fromEntries(adoptable.map((resource) => [
    resource.target,
    resource.current_digest!
  ]));
  callbacks.confirm({
    title: `Let “${pack.displayName}” manage these definitions?`,
    body: <>
      <p>The collection has older unmanaged files at the pack’s managed paths.</p>
      <ul>{adoptable.map((resource) => <li key={resource.target}><code>{resource.target}</code></li>)}</ul>
      <p>The editor will replace these reviewed files and record their exact source, version, and digest in <code>mdbase.lock.yaml</code>. Future upgrades stop instead of overwriting an unexpected edit.</p>
    </>,
    confirmLabel: "Adopt and update",
    cancelLabel: "Not now",
    initialFocus: "cancel",
    onConfirm: async () => {
      try {
        const reviewed = await gateway.assessTypePack(provision, adoptions);
        if (!reviewed.applicable) {
          throw new Error(reviewed.resources.find(({ action }) => action === "conflict")?.reason
            ?? "The definitions changed while they were being reviewed.");
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
    callbacks.notify(`Added “${pack.displayName}” and opened the new type.`);
    return;
  }
  callbacks.notify(`Installed “${pack.displayName}” (${installed.resources.length} resources, ${addedTypes.length} new ${addedTypes.length === 1 ? "type" : "types"}).`);
}
