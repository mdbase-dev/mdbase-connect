import { describe, expect, it } from "vitest";
import { installationApp } from "./installation-pairing.js";

const local = "http://127.0.0.1:48218";
describe("fixed first-party installation origins", () => {
  it("allows only the exact isolated LAB TaskNotes web app origin and retains the existing LAB origin", () => {
    for (const origin of [local,"https://lab.tasknotes-app.pages.dev"]) {
      const app = installationApp("lab","tasknotes-web",origin,"app-runtime");
      expect(app).toEqual({id:"tasknotes-web",origin,name:"TaskNotes"});
      expect(Object.isFrozen(app)).toBe(true);
    }
  });
  it.each(["production","staging",undefined,"development","LAB"])("LAB origin never appears in %s environment policy", environment => {
    expect(()=>installationApp(environment,"tasknotes-web",local,"app-runtime")).toThrow("Preserve its state");
  });
  it.each(["http://localhost:48218","http://127.0.0.1:48219","http://127.0.0.1","https://127.0.0.1:48218","http://127.0.0.1:48218/","http://127.0.0.1:48218/path","http://127.0.0.2:48218",undefined])("refuses missing/changed host, port, scheme or URL form %s", origin => {
    expect(()=>installationApp("lab","tasknotes-web",origin,"app-runtime")).toThrow("Preserve its state");
  });
  it("preserves production/staging web maps without a loopback or cross-environment fallback", () => {
    expect(installationApp("production","tasknotes-web","https://app.tasknotes.dev","app-runtime").origin).toBe("https://app.tasknotes.dev");
    expect(installationApp("staging","tasknotes-web","https://staging.tasknotes-app.pages.dev","app-runtime").origin).toBe("https://staging.tasknotes-app.pages.dev");
    expect(()=>installationApp("production","tasknotes-web","https://lab.tasknotes-app.pages.dev","app-runtime")).toThrow();
    expect(()=>installationApp("staging","tasknotes-web","https://app.tasknotes.dev","app-runtime")).toThrow();
  });
  it("preserves mobile map and rejects LAB loopback for mobile, changed app or kind", () => {
    for (const environment of ["lab","staging","production"]) for (const origin of ["https://app.tasknotes.dev","capacitor://app.tasknotes.dev"])
      expect(installationApp(environment,"tasknotes-mobile",origin,"mobile")).toMatchObject({id:"tasknotes-mobile",origin});
    expect(()=>installationApp("lab","tasknotes-mobile",local,"mobile")).toThrow();
    expect(()=>installationApp("lab","tasknotes-web",local,"mobile")).toThrow();
    expect(()=>installationApp("lab","unregistered-app",local,"app-runtime")).toThrow();
  });
});
