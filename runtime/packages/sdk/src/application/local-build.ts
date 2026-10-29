import { LOCAL_APPLICATION_BUILD } from "../local-build.js";
export { LOCAL_APPLICATION_BUILD, localApplicationHttpOrigin, localApplicationWebSocketUrl } from "../local-build.js";

export function localApplicationEnvironment(environment: string): boolean {
  return LOCAL_APPLICATION_BUILD && environment === "local";
}

export function applicationEnvironmentAllowed(environment: string): boolean {
  return LOCAL_APPLICATION_BUILD ? environment === "local" : environment === "lab" || environment === "staging" || environment === "production";
}

export function applicationLoopbackAllowed(environment: string): boolean {
  return LOCAL_APPLICATION_BUILD ? environment === "local" : environment === "lab";
}

export function localApplicationOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0
      && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
