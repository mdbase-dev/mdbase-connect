export function shouldRegisterDeepLinks(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return environment.MDBASE_CONNECT_REGISTER_DEEP_LINKS !== "0";
}

export function routeForDeepLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "mdbase-connect:") return null;
    if (url.hostname === "authorize") {
      const requestId = url.searchParams.get("request_id");
      return requestId ? `access:${requestId}` : "access";
    }
    if (url.hostname === "mirror") {
      const collectionId = url.searchParams.get("collection");
      return collectionId ? `collections:mirror:${collectionId}` : "collections";
    }
    if (url.hostname === "paired") return "overview";
  } catch {
    return null;
  }
  return null;
}
