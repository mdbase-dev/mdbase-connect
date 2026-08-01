const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resolveDevelopmentOrigins(environment, bindPort = "8787") {
  const defaultEditorOrigin = "http://127.0.0.1:5173";
  const publicUrl = environment.PUBLIC_URL?.trim()
    || `http://127.0.0.1:${bindPort}`;
  const configuredManagementOrigins = environment.MDBASE_CONNECT_MANAGEMENT_ORIGINS?.trim()
    || environment.MDBASE_EDITOR_ORIGIN?.trim()
    || defaultEditorOrigin;
  const managementOrigins = configuredManagementOrigins
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const editorOrigin = new URL(
    environment.MDBASE_EDITOR_ORIGIN?.trim() || managementOrigins[0]
  ).origin;

  assertCompatibleLoopbackSites(publicUrl, [...managementOrigins, editorOrigin]);

  return {
    publicUrl: new URL(publicUrl).href.replace(/\/$/, ""),
    managementOrigins,
    editorOrigin
  };
}

function assertCompatibleLoopbackSites(publicUrl, managementOrigins) {
  const connect = new URL(publicUrl);
  const connectSite = loopbackSite(connect);

  for (const origin of managementOrigins) {
    const management = new URL(origin);
    const managementSite = loopbackSite(management);
    if ((connectSite || managementSite) && connectSite !== managementSite) {
      throw new Error(
        `Development browser origins must use the same loopback host and scheme. `
        + `PUBLIC_URL uses ${connect.origin}, but the editor uses ${management.origin}. `
        + "Use 127.0.0.1 for both or localhost for both; mixing them causes a sign-in redirect loop."
      );
    }
  }
}

function loopbackSite(url) {
  return loopbackHosts.has(url.hostname)
    ? `${url.protocol}//${url.hostname}`
    : null;
}
