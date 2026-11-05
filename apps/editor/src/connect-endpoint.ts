const productionConnectOrigin = "https://connect.mdbase.dev";
// The native publisher sets only the application environment; derive its Connect
// portal the same way scripts/write-manifest.mjs pins it.
export function environmentConnectServerUrl(environment: string | undefined): string {
  return environment === "staging" ? "https://connect-staging.mdbase.dev" : productionConnectOrigin;
}

export const configuredConnectServerUrl =
  import.meta.env.VITE_MDBASE_CONNECT_URL ?? environmentConnectServerUrl(import.meta.env.VITE_MDBASE_ENV);

export function connectServerUrl(
  search = location.search,
  configuredServerUrl = configuredConnectServerUrl
): string {
  const values = new URLSearchParams(search).getAll("server");
  if (values.length > 1) throw new TypeError("Ambiguous Connect server origin");
  const url = new URL(values[0] ?? configuredServerUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && url.protocol !== "http:")) throw new TypeError("Invalid Connect server origin");
  return url.origin;
}

export function editorPortalUrl(search = location.search): string | null {
  try {
    return connectServerUrl(search);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function applyConnectServerOverride(
  url: URL,
  serverUrl: string,
  configuredServerUrl = configuredConnectServerUrl
): URL {
  const activeOrigin = new URL(serverUrl).origin;
  const configuredOrigin = new URL(configuredServerUrl).origin;
  if (activeOrigin === configuredOrigin) url.searchParams.delete("server");
  else url.searchParams.set("server", activeOrigin);
  return url;
}
