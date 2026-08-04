import { describe, expect, it } from "vitest";
import {
  ApplicationManifestError,
  isNativeRedirectUri,
  registerApplicationManifest
} from "./manifest.js";
import { canonicalJson, canonicalSha256 } from "./canonical-json.js";

const TEST_CONTRACT_DIGEST = `sha256:${"0".repeat(64)}`;

describe("canonical protocol JSON", () => {
  it("hashes equivalent objects identically regardless of insertion order", () => {
    const left = { z: 1, a: { beta: true, alpha: ["x", 2] } };
    const right = { a: { alpha: ["x", 2], beta: true }, z: 1 };
    expect(canonicalJson(left)).toBe('{"a":{"alpha":["x",2],"beta":true},"z":1}');
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
  });

  it("rejects values outside the JSON data model", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow("non-finite");
    expect(() => canonicalJson(1n)).toThrow("bigint");
  });
});

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
  it("accepts explicit first-class file intent without record contracts", () => {
    const registered = registerApplicationManifest({
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.assets",
      name: "Asset Browser",
      requirements: {
        contracts: [],
        capabilities: {
          contract_version: 1,
          required: ["collection.inspect", "files.list", "files.read"]
        },
        files: {
          actions: ["list", "read"],
          scope: { kind: "selected_folders", folders: ["Assets", "Exports/Final"] }
        }
      }
    });

    expect(registered.manifest.requirements.files).toEqual({
      actions: ["list", "read"],
      scope: { kind: "selected_folders", folders: ["Assets", "Exports/Final"] }
    });
  });

  it.each([
    { actions: [], scope: { kind: "collection" } },
    { actions: ["read", "read"], scope: { kind: "collection" } },
    { actions: ["read"], scope: { kind: "selected_folders", folders: ["../private"] } },
    { actions: ["read"], scope: { kind: "selected_folders", folders: ["Assets//Raw"] } },
    { actions: ["read"], scope: { kind: "selected_folders", folders: [".hidden"] } },
    { actions: ["read"], scope: { kind: "selected_folders", folders: ["_types"] } }
  ])("rejects unsafe or ambiguous file intent %#", (files) => {
    expect(() => registerApplicationManifest({
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.assets",
      name: "Asset Browser",
      requirements: { contracts: [], files }
    })).toThrow(ApplicationManifestError);
  });

  it("registers an exact v1 portable declaration without a claimed origin", () => {
    const registered = registerApplicationManifest({
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.workouts",
      name: "Portable Workouts",
      project_url: "https://workouts.example/source",
      icon: "https://workouts.example/icon.svg",
      requirements: {
        contracts: [{
          id: "workout.record",
          version: "1.0.0",
          digest: TEST_CONTRACT_DIGEST
        }]
      }
    });

    expect(registered.manifest).toMatchObject({
      distribution: "portable",
      project_url: "https://workouts.example/source",
      requirements: {
        contracts: [{
          id: "workout.record",
          version: "1.0.0",
          digest: TEST_CONTRACT_DIGEST
        }]
      }
    });
    expect(registered.canonicalIdentity)
      .toMatch(/^bundle:dev\.mdbase\.workouts:sha256:[a-f0-9]{64}$/);
    expect(registered.manifest).not.toHaveProperty("homepage");
    expect(registered.manifest).not.toHaveProperty("redirect_uris");
  });

  it("rejects web identity fields and cross-origin icons", () => {
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
    })).toThrow("/icon must use the project_url origin");
    expect(registerApplicationManifest({
      ...base,
      requirements: {
        contracts: [],
        collection_kind: "hosted"
      }
    }).manifest.requirements.collection_kind).toBe("hosted");
  });

  it("reports the exact missing type-pack ownership path", () => {
    const document = "---\nkind: mdbase.type\nname: scratch\nversion: 1\n---\n";
    const invalid = {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.scratch",
      name: "Scratch",
      provisions: {
        type_packs: [{
          manifest: {
            kind: "mdbase.type-pack",
            id: "dev.mdbase.scratch",
            version: "1.0.0",
            resources: [{
              kind: "type",
              source: "types/scratch.md",
              target: "_types/scratch.md",
              digest: canonicalSha256(document)
            }]
          },
          resources: [{ source: "types/scratch.md", document }],
          provides: []
        }]
      }
    };

    expect(() => registerApplicationManifest(invalid)).toThrow(
      "/provisions/type_packs/0/manifest/resources/0/mode is required"
    );
    try {
      registerApplicationManifest(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationManifestError);
      expect((error as ApplicationManifestError).issues[0]).toMatchObject({
        path: "/provisions/type_packs/0/manifest/resources/0/mode",
        keyword: "required"
      });
    }
  });
});
