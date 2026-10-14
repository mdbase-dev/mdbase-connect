import { LOCAL_REHEARSAL_BUILD } from "./local-build.js";

export function localBuild(): boolean { return LOCAL_REHEARSAL_BUILD; }
export function rehearsalDiagnostics(environment: string | undefined): boolean {
  return LOCAL_REHEARSAL_BUILD ? environment === "local" : environment === "lab";
}

export function localDeployment(environment: string | undefined, value: string): boolean {
  if (!LOCAL_REHEARSAL_BUILD || environment !== "local") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port
      && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
