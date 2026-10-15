import { LOCAL_REHEARSAL_BUILD } from "./local-build.js";

export type InstallationEnvironment = "lab" | "staging" | "production" | "local";

/** Managed decoding is unchanged. Local metadata additionally needs the actual
 * server environment and an exact loopback origin, never its own claimed env. */
export function installationEnvironment(
  environment: unknown, origin: unknown, serverEnvironment: string | undefined,
): environment is InstallationEnvironment {
  return typeof environment === "string" && (["lab", "staging", "production"].includes(environment)
    || (environment === serverEnvironment && typeof origin === "string" && localDeployment(serverEnvironment, origin)));
}

export function localBuild(): boolean { return LOCAL_REHEARSAL_BUILD; }
export function rehearsalDiagnostics(environment: string | undefined): boolean {
  return LOCAL_REHEARSAL_BUILD ? environment === "local" : environment === "lab";
}

export function localDeployment(environment: string | undefined, value: string): boolean {
  if (!LOCAL_REHEARSAL_BUILD || environment !== "local") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port && Number(url.port) > 0
      && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
