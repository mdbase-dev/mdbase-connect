// Which web pages the app opens on the daemon's behalf: its sign-in approval page
// and the account page. Only the control plane of the environment the daemon was
// built for is accepted, never a server it merely reports. Loopback is accepted
// only for isolated development profiles (unpackaged builds).

export const CONTROL_PLANES: Readonly<Record<string, string>> = Object.freeze({
  production: "https://connect.mdbase.dev",
  lab: "https://connect-lab.mdbase.dev"
});

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ApprovalUrlPolicy {
  /** The daemon's build environment (`status.account.environment`). */
  environment: string | undefined;
  /** Unpackaged build on an isolated profile: a loopback test server is allowed. */
  allowLoopback: boolean;
}

/** Returns the URL exactly as given (its query carries the request) once it is allowed. */
export function checkApprovalUrl(value: unknown, policy: ApprovalUrlPolicy): string {
  if (typeof value !== "string" || !value) throw new Error("mdbase did not return a sign-in page.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("mdbase returned a sign-in page that is not a web address.");
  }
  if (url.username || url.password) throw new Error("The mdbase sign-in page must not contain credentials.");
  const loopback = policy.allowLoopback && LOOPBACK.has(url.hostname) && (url.protocol === "http:" || url.protocol === "https:");
  if (loopback) return url.href;
  const expected = policy.environment ? CONTROL_PLANES[policy.environment] : undefined;
  if (!expected) throw new Error("This mdbase build does not name a known mdbase service.");
  if (url.origin !== expected) throw new Error(`mdbase pages open only on ${expected}.`);
  return url.href;
}
