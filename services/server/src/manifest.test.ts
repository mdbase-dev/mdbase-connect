import { describe, expect, it } from "vitest";
import {
  ApplicationManifestError,
  isNativeRedirectUri,
  registerApplicationManifest
} from "./manifest.js";

describe("native manifest callbacks", () => {
  it("accepts a reverse-domain private-use application scheme", () => {
    expect(isNativeRedirectUri(
      new URL("dev.worklog.app://auth/mdbase/callback"),
      "worklog.dev"
    )).toBe(true);
  });

  it("binds the private-use scheme to the manifest publisher", () => {
    expect(isNativeRedirectUri(
      new URL("com.example.app://auth/mdbase/callback"),
      "worklog.dev"
    )).toBe(false);
  });

  it.each([
    "worklog://auth/callback",
    "javascript://auth/callback",
    "dev.worklog.app://user:secret@auth/callback",
    "dev.worklog.app://auth/callback#fragment"
  ])("rejects an unsafe native callback %s", (value) => {
    expect(isNativeRedirectUri(new URL(value))).toBe(false);
  });
});

describe("portable application manifests", () => {
  it("registers an exact v1 portable declaration without a claimed origin", () => {
    const registered = registerApplicationManifest({
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.workouts",
      name: "Portable Workouts",
      project_url: "https://workouts.example/source",
      icon: "https://workouts.example/icon.svg",
      requirements: {
        contracts: [{ id: "workout.record", version: 1 }]
      }
    });

    expect(registered.manifest).toMatchObject({
      distribution: "portable",
      project_url: "https://workouts.example/source",
      requirements: {
        contracts: [{ id: "workout.record", version: 1 }]
      }
    });
    expect(registered.canonicalIdentity)
      .toMatch(/^bundle:dev\.mdbase\.workouts:sha256:[a-f0-9]{64}$/);
    expect(registered.manifest).not.toHaveProperty("homepage");
    expect(registered.manifest).not.toHaveProperty("redirect_uris");
  });

  it("rejects web identity fields, cross-origin icons, and hosted-only portable access", () => {
    const base = {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.workouts",
      name: "Portable Workouts"
    } as const;

    expect(() => registerApplicationManifest({
      ...base,
      homepage: "https://workouts.example/",
      redirect_uris: ["https://workouts.example/callback"]
    })).toThrow(ApplicationManifestError);
    expect(() => registerApplicationManifest({
      ...base,
      project_url: "https://workouts.example/source",
      icon: "https://tracking.example/icon.svg"
    })).toThrow("Portable application icons must use the project URL origin.");
    expect(() => registerApplicationManifest({
      ...base,
      requirements: {
        contracts: [],
        collection_kind: "hosted"
      }
    })).toThrow("Portable applications cannot request hosted-only collection access.");
  });
});
