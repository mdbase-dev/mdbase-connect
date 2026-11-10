import { LOCAL_APPLICATION_BUILD } from "../local-build.js";
export { LOCAL_APPLICATION_BUILD, loopbackHttpOrigin, localApplicationHttpOrigin, localApplicationWebSocketUrl } from "../local-build.js";

export function localApplicationEnvironment(environment: string): boolean {
  return LOCAL_APPLICATION_BUILD && environment === "local";
}

export function applicationEnvironmentAllowed(environment: string): boolean {
  return LOCAL_APPLICATION_BUILD ? environment === "local" : environment === "lab" || environment === "staging" || environment === "production";
}

/** Whether mdbase's own origins (control plane, log) may be loopback HTTP: LAB
 * and local builds only. An application's own origin does not depend on it. */
export function serviceLoopbackAllowed(environment: string): boolean {
  return LOCAL_APPLICATION_BUILD ? environment === "local" : environment === "lab";
}

export function localApplicationOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0
      && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
