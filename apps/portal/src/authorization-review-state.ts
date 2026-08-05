export interface StoredAuthorizationReview {
  collectionId?: string;
  operations?: string[];
  reviewing?: boolean;
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

export function clearAuthorizationReview(requestId: string): void {
  try {
    sessionStorage.removeItem(storageKey(requestId));
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }
}
