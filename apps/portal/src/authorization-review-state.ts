export interface StoredAuthorizationReview {
  collectionId?: string;
  collectionConfirmed?: boolean;
  operations?: string[];
  reviewing?: boolean;
}

export function initialAuthorizationSelection(
  compatibleCollectionIds: readonly string[],
  savedReview: StoredAuthorizationReview | null
): { collectionId: string; reviewing: boolean } {
  const collectionId = savedReview?.collectionConfirmed === true
    && savedReview.collectionId
    && compatibleCollectionIds.includes(savedReview.collectionId)
      ? savedReview.collectionId
      : "";
  return {
    collectionId,
    reviewing: Boolean(collectionId && savedReview?.reviewing === true)
  };
}

interface CollectionLocationChoice {
  id: string;
  display_name: string;
  connector_name: string;
}

function disambiguatedCollectionLocations(
  collections: CollectionLocationChoice[]
): Map<string, string> {
  const groups = new Map<string, CollectionLocationChoice[]>();
  for (const collection of collections) {
    const key = [
      collection.display_name.normalize("NFKC").toLocaleLowerCase(),
      collection.connector_name.normalize("NFKC").toLocaleLowerCase()
    ].join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(collection);
    groups.set(key, group);
  }

  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    for (const collection of group) {
      labels.set(
        collection.id,
        group.length === 1
          ? collection.connector_name
          : `${collection.connector_name} · ID …${uniqueIdSuffix(
              collection.id,
              group.map((candidate) => candidate.id)
            )}`
      );
    }
  }
  return labels;
}

function uniqueIdSuffix(id: string, candidates: string[]): string {
  let length = Math.min(8, id.length);
  while (
    length < id.length &&
    candidates.some(
      (candidate) =>
        candidate !== id && candidate.slice(-length) === id.slice(-length)
    )
  ) {
    length += 1;
  }
  return id.slice(-length);
}

function storageKey(requestId: string): string {
  return `mdbase:authorization-review:${requestId}`;
}

export function storedAuthorizationReview(requestId: string): StoredAuthorizationReview | null {
  try {
    const stored = sessionStorage.getItem(storageKey(requestId));
    if (!stored) return null;
    const value = JSON.parse(stored) as StoredAuthorizationReview;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function saveAuthorizationReview(requestId: string, value: StoredAuthorizationReview): void {
  try {
    sessionStorage.setItem(storageKey(requestId), JSON.stringify(value));
  } catch {
    // Authorization still works when browser storage is unavailable.
  }
}

function clearAuthorizationReview(requestId: string): void {
  try {
    sessionStorage.removeItem(storageKey(requestId));
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }
}

export { clearAuthorizationReview, disambiguatedCollectionLocations };
