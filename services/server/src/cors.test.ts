import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

const deployments = {
  production: ["https://app.tasknotes.dev", "https://writer.mdbase.dev", "https://journal.mdbase.dev", "https://reader.mdbase.dev", "https://editor.mdbase.dev", "chrome-extension://kimdfjefhbfgfecconmaiaaindjccidp"],
  staging: ["https://staging.tasknotes-app.pages.dev", "https://staging.mdbase-writer.pages.dev", "https://staging.mdbase-journal.pages.dev", "https://staging.mdbase-reader.pages.dev", "https://editor-staging.mdbase.dev", "chrome-extension://palmhjikdacodimpnkapmidobfbocdgf"],
  lab: ["https://lab.tasknotes-app.pages.dev", "https://lab.mdbase-writer.pages.dev", "https://lab.mdbase-journal-lab.pages.dev", "https://lab.mdbase-reader.pages.dev", "https://editor-lab.mdbase.dev", "https://mdbase-editor-lab.pages.dev", "http://127.0.0.1:48218", "chrome-extension://kimdfjefhbfgfecconmaiaaindjccidp"]
};
const resources: Array<() => Promise<void>> = [];
afterAll(async () => { while (resources.length) await resources.pop()!(); });

for (const [environment, origins] of Object.entries(deployments)) {
  describe(`${environment} CORS`, () => {
    let app: Awaited<ReturnType<typeof buildApp>>["app"];
    beforeAll(async () => {
      const db = await createDatabase("memory"); resources.push(() => db.end());
      ({ app } = await buildApp({ db, environment, publicUrl: "https://connect.example",
        managementOrigins: ["https://management.example"], editorOrigin: "https://editor.example" }));
      resources.push(() => app.close());
    });

    it("allows deployed web/native apps and configured management origins", async () => {
      for (const origin of [...origins, "https://connect.example", "https://management.example", "https://editor.example",
        "https://app.tasknotes.dev", "capacitor://app.tasknotes.dev", "https://localhost", "capacitor://localhost"]) {
        const response = await app.inject({ url: "/v1/auth/config", headers: { origin } });
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
        expect(response.headers["access-control-allow-credentials"]).toBe("true");
        expect(response.headers.vary).toContain("Origin");
        const preflight = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: {
          origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization,content-type"
        } });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
        expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
        expect(preflight.headers["access-control-max-age"]).toBe("7200");
      }
    });

    it("does not allow sibling, lookalike, other-environment or null origins", async () => {
      const otherEnvironment = environment === "production" ? deployments.staging : deployments.production;
      for (const origin of ["https://other.mdbase.dev", "https://reader.mdbase.dev.example", "https://preview.mdbase-reader.pages.dev",
        "http://reader.mdbase.dev", "https://reader.mdbase.dev:444", "null", otherEnvironment[1]]) {
        for (const method of ["GET", "OPTIONS"] as const) {
          const response = await app.inject({ method, url: "/v1/me", headers: {
            origin, cookie: "mdbase_session=synthetic", "access-control-request-method": "GET"
          } });
          expect(response.headers["access-control-allow-origin"]).toBeUndefined();
          expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
        }
      }
    });

    it("leaves originless clients working without CORS headers", async () => {
      const response = await app.inject({ url: "/v1/auth/config" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    });
  });
}
