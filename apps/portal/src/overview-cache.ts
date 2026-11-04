import type { ManagementOverview } from "@mdbase/connect-management";
import { clearPagePrefetch } from "./page-prefetch";

type CachedRow = { id: string; name: string };
export type OverviewPreview = { userId: string; collections: CachedRow[]; computers: CachedRow[] };
const accountKey = "connect-overview-account";
const prefix = "connect-overview-v1:";

export function readOverviewPreview(): OverviewPreview | undefined {
  try {
    const userId = sessionStorage.getItem(accountKey);
    if (!userId) return;
    const value = JSON.parse(localStorage.getItem(prefix + userId) ?? "null");
    const rows = (input: unknown): input is CachedRow[] => Array.isArray(input) && input.every(row =>
      row && typeof row.id === "string" && typeof row.name === "string");
    if (value?.userId === userId && rows(value.collections) && rows(value.computers)) return value;
  } catch {}
}

export function writeOverviewPreview(data: ManagementOverview): void {
  const preview: OverviewPreview = {
    userId: data.user.id,
    collections: [...data.collections, ...data.hosted_collections, ...(data.native_collections ?? [])]
      .filter(collection => collection.display_name !== null)
      .map(collection => ({ id: collection.id, name: collection.display_name! })),
    computers: data.connectors.map(computer => ({ id: computer.id, name: computer.name }))
  };
  try {
    const previous = sessionStorage.getItem(accountKey);
    if (previous && previous !== data.user.id) localStorage.removeItem(prefix + previous);
    localStorage.setItem(prefix + data.user.id, JSON.stringify(preview));
    sessionStorage.setItem(accountKey, data.user.id);
  } catch {}
}

export function clearOverviewPreview(): void {
  clearPagePrefetch();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    sessionStorage.removeItem(accountKey);
  } catch {}
}
