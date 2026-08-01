export function authorityUrl(
  baseUrl: string,
  collectionId: string,
  capability: "operations" | "sync" | "files"
): string {
  const base = new URL(baseUrl);
  base.pathname = `/v1/authorities/${encodeURIComponent(collectionId)}/${capability}`;
  base.search = "";
  base.hash = "";
  return base.href.replace(/\/$/, "");
}

export function authorityImportCapability(
  providerUrl: string,
  transferId: string,
  accessToken: string
): Record<string, string> {
  const base = new URL(providerUrl);
  const path = `/v1/authority-imports/${encodeURIComponent(transferId)}`;
  const endpoint = (suffix: string) => {
    const url = new URL(base);
    url.pathname = `${path}/${suffix}`;
    url.search = "";
    url.hash = "";
    return url.href;
  };
  return {
    import_id: transferId,
    manifest_url: endpoint("manifest"),
    records_url: endpoint("records"),
    files_url: endpoint("files"),
    finalize_url: endpoint("finalize"),
    access_token: accessToken
  };
}
