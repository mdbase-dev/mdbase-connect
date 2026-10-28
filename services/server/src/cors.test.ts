import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

// Deployed client origins. None of these uses the account session cookie:
// web apps and SDKs send bearer tokens with credentials omitted, so CORS
// reflects their origin without allowing credentials.
const appOrigins = [
  // TaskNotes, Writer, Journal, Reader, Editor web (production, staging, LAB).
  "https://app.tasknotes.dev", "https://staging.tasknotes-app.pages.dev", "https://lab.tasknotes-app.pages.dev",
  "https://writer.mdbase.dev", "https://staging.mdbase-writer.pages.dev", "https://lab.mdbase-writer.pages.dev",
  "https://journal.mdbase.dev", "https://staging.mdbase-journal.pages.dev", "https://lab.mdbase-journal-lab.pages.dev",
  "https://reader.mdbase.dev", "https://staging.mdbase-reader.pages.dev", "https://lab.mdbase-reader.pages.dev",
  "https://editor-lab.mdbase.dev", "https://mdbase-editor-lab.pages.dev", "http://127.0.0.1:48218",
  // Current canonical and preview app hosts; all use bearer auth.
  "https://editor.mdbase.dev", "https://editor-staging.mdbase.dev",
  "https://planner.mdbase.dev", "https://staging.mdbase-planner.pages.dev", "https://lab.mdbase-planner.pages.dev",
  "https://mdbase.dev", "https://staging.mdbase.dev",
  // Native, desktop, extension and plugin shells.
  "capacitor://app.tasknotes.dev", "https://localhost", "capacitor://localhost", "http://localhost",
  "tauri://localhost", "http://tauri.localhost", "app://obsidian.md",
  "chrome-extension://kimdfjefhbfgfecconmaiaaindjccidp", "chrome-extension://palmhjikdacodimpnkapmidobfbocdgf",
  // Third-party SDK apps and look-alikes.
  "https://application.example", "https://callumalpass.github.io", "https://other.mdbase.dev",
  "https://connect.example.evil", "http://connect.example", "https://connect.example:444",
  "https://preview.mdbase-reader.pages.dev", "null"
];
const deployments = [
  ["production", "https://connect.mdbase.dev", "https://editor.mdbase.dev"],
  ["staging", "https://connect-staging.mdbase.dev", "https://editor-staging.mdbase.dev"],
  ["lab", "https://connect-lab.mdbase.dev", "https://editor-lab.mdbase.dev"],
  ["local", "http://127.0.0.1:8787", "http://127.0.0.1:5173"]
];
const resources: Array<() => Promise<void>> = [];
afterAll(async () => { while (resources.length) await resources.pop()!(); });

for (const [environment, publicUrl, editorOrigin] of deployments) {
  describe(`${environment} CORS`, () => {
    let app: Awaited<ReturnType<typeof buildApp>>["app"];
    beforeAll(async () => {
      const db = await createDatabase("memory"); resources.push(() => db.end());
      ({ app } = await buildApp({ db, environment, publicUrl,
        managementOrigins: ["https://management.example", editorOrigin], editorOrigin }));
      resources.push(() => app.close());
    });

    it("allows credentials only for the account and management origins", async () => {
      for (const origin of [publicUrl, "https://management.example", editorOrigin]) {
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

    it("reflects app, native, extension, plugin, third-party and null origins without credentials", async () => {
      for (const origin of appOrigins.filter(origin => origin !== editorOrigin)) {
        const preflight = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: {
          origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type"
        } });
        expect(preflight.statusCode, origin).toBe(204);
        expect(preflight.headers["access-control-allow-origin"], origin).toBe(origin);
        expect(preflight.headers["access-control-allow-credentials"], origin).toBeUndefined();
        expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase(), origin).toContain("authorization");
        expect(String(preflight.headers["access-control-allow-methods"]), origin).toContain("POST");
        // A bearer-authenticated request stays readable from the app origin.
        const bearer = await app.inject({ url: "/v1/auth/config", headers: { origin, authorization: "Bearer synthetic" } });
        expect(bearer.statusCode, origin).toBe(200);
        expect(bearer.headers["access-control-allow-origin"], origin).toBe(origin);
        expect(bearer.headers["access-control-allow-credentials"], origin).toBeUndefined();
      }
    });

    it("still refuses an ambient session cookie from a non-account origin", async () => {
      for (const origin of ["https://app.tasknotes.dev", "https://writer.mdbase.dev", "app://obsidian.md", "https://application.example"]) {
        const response = await app.inject({ url: "/v1/me", headers: { origin, cookie: "mdbase_session=synthetic" } });
        expect(response.statusCode, origin).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "origin_denied" } });
        expect(response.headers["access-control-allow-credentials"], origin).toBeUndefined();
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
