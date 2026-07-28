const DEFAULT_EDITOR_URL = "https://editor.mdbase.dev/";

export function buildEditorUrl(
  collectionId: unknown,
  baseUrl = process.env.MDBASE_EDITOR_URL ?? DEFAULT_EDITOR_URL
): string {
  if (typeof collectionId !== "string" || collectionId.trim().length === 0) {
    throw new Error("Invalid collection ID.");
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The mdbase editor URL must be a credential-free HTTPS URL.");
  }
  url.searchParams.set("collection", collectionId);
  return url.href;
}
