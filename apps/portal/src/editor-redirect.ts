interface RedirectLocation {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
}

export function editorRedirectTarget(
  configuredTarget: string,
  source: RedirectLocation = location
): string {
  const target = new URL(configuredTarget, source.origin);
  if (source.pathname !== "/account") return target.href;
  target.pathname = "/connect/account";
  const linked = new URLSearchParams(source.search).get("linked");
  if (linked === "github" || linked === "google") target.searchParams.set("linked", linked);
  const deletionToken = new URLSearchParams(source.hash.slice(1)).get("delete_token");
  if (deletionToken && /^act_[A-Za-z0-9_-]+$/.test(deletionToken)) {
    target.hash = `delete_token=${encodeURIComponent(deletionToken)}`;
  }
  return target.href;
}
