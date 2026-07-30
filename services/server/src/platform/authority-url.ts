export function authorityUrl(
  baseUrl: string,
  collectionId: string,
  capability: "operations" | "sync"
): string {
  const base = new URL(baseUrl);
  base.pathname = `/v1/authorities/${encodeURIComponent(collectionId)}/${capability}`;
  base.search = "";
  base.hash = "";
  return base.href.replace(/\/$/, "");
}
