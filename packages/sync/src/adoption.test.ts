import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuthorityAdoptionClient,
  AuthorityAdoptionOutcomeUnknownError,
  buildPortableAuthoritySnapshot,
  portableRecordId,
  type AuthorityAdoptionRequest,
  type AuthorityAdoptionResponse,
  type AuthorityAdoptionSession,
  type PreparedAuthorityAdoption
} from "./adoption.js";

const collectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const adoptionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = Date.parse("2026-07-27T00:00:00.000Z");

describe("portable authority snapshot", () => {
  it("is deterministic, includes first-class resources, and derives stable record IDs", () => {
    const first = snapshot([
      { path: "_schemas/task.json", kind: "schema" as const, document: "{\"type\":\"object\"}\n" },
      { path: "_contracts/task.md", kind: "contract" as const, document: "---\nkind: mdbase.contract\n---\n" },
      { path: "views/tasks.base", kind: "view" as const, document: "views: []\n" },
      { path: "mdbase.lock.yaml", kind: "lock" as const, document: "kind: mdbase.type-pack-lock\nlock_version: 1\npacks: []\n" },
      { path: "mdbase.yaml", kind: "configuration" as const, document: "spec_version: 0.3.0\n" }
    ]);
    const repeated = snapshot([
      { path: "mdbase.yaml", kind: "configuration" as const, document: "spec_version: 0.3.0\n" },
      { path: "views/tasks.base", kind: "view" as const, document: "views: []\n" },
      { path: "_contracts/task.md", kind: "contract" as const, document: "---\nkind: mdbase.contract\n---\n" },
      { path: "_schemas/task.json", kind: "schema" as const, document: "{\"type\":\"object\"}\n" },
      { path: "mdbase.lock.yaml", kind: "lock" as const, document: "kind: mdbase.type-pack-lock\nlock_version: 1\npacks: []\n" }
    ]);

    expect(repeated).toEqual(first);
    expect(first.resources.documents?.map(({ kind, path }) => [kind, path])).toEqual([
      ["configuration", "mdbase.yaml"],
      ["contract", "_contracts/task.md"],
      ["schema", "_schemas/task.json"],
      ["lock", "mdbase.lock.yaml"],
      ["view", "views/tasks.base"]
    ]);
    expect(first.records[0]?.record_id).toBe(
      portableRecordId(collectionId, "notes/one.md")
    );
    expect(first.source_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate and unsafe paths before anything is uploaded", () => {
    expect(() => buildPortableAuthoritySnapshot({
      collectionId,
      specVersion: "0.3.0",
      resources: [
        { path: "mdbase.yaml", kind: "configuration", document: "spec_version: 0.3.0\n" }
      ],
      records: [{
        path: "../escape.md",
        document: ""
      }]
    })).toThrow(/unsafe/);
  });

  it("matches the mdbase-rs portable snapshot digest fixture", () => {
    const fixture = buildPortableAuthoritySnapshot({
      collectionId,
      specVersion: "0.3.0",
      resources: [
        {
          path: "mdbase.yaml",
          kind: "configuration",
          document:
            "spec_version: 0.3.0\nx-obsidian:\n  bases:\n    include:\n      - views/**/*.base\n"
        },
        {
          path: "views/tasks.base",
          kind: "view",
          document: "views: []\n"
        }
      ],
      records: [{
        path: "notes/one.md",
        document: "---\ntitle: One\n---\nBody\n"
      }]
    });
    expect(fixture.resources.revision).toBe(
      "sha256:09367b66bc7e29a90ee2cafa992f3477dd523d09558f542fb9fe4418312984a8"
    );
    expect(fixture.source_revision).toBe(
      "sha256:b01ab663203cd44b2a837e0a2fcf73f06bd0cae8787efb3148c3821f255e4806"
    );
  });
});

describe("AuthorityAdoptionClient", () => {
  it("polls approval and uploads manifest, records, and finalize in order", async () => {
    let clock = now;
    const requests: AuthorityAdoptionRequest[] = [];
    const responses: AuthorityAdoptionResponse[] = [
      {
        status: 201,
        body: {
          adoption_id: adoptionId,
          adoption_secret: "adp_a_very_long_secret",
          verification_uri: `https://connect.test/adopt/${adoptionId}`,
          expires_in: 1800
        }
      },
      { status: 202, body: { status: "pending" } },
      readyResponse(),
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} }
    ];
    const client = new AuthorityAdoptionClient({
      now: () => clock,
      wait: async (milliseconds) => { clock += milliseconds; },
      request: async (request) => {
        requests.push(request);
        return responses.shift()!;
      }
    });
    const session = await client.begin({
      controlUrl: "https://connect.test",
      collectionId,
      displayName: "Notes",
      sourceName: "Phone",
      retainMirror: true
    });
    const prepared = await client.waitForApproval(session, { pollIntervalMs: 250 });
    await client.uploadSnapshot(session, prepared, snapshot());

    expect(requests.map(({ method, url }) => [
      method,
      new URL(url).pathname
    ])).toEqual([
      ["POST", "/v1/authority-adoptions"],
      ["POST", `/v1/authority-adoptions/${adoptionId}/exchange`],
      ["POST", `/v1/authority-adoptions/${adoptionId}/exchange`],
      ["PUT", `/v1/authority-imports/${adoptionId}/manifest`],
      ["PUT", `/v1/authority-imports/${adoptionId}/records`],
      ["POST", `/v1/authority-imports/${adoptionId}/finalize`]
    ]);
    expect((requests[3]?.body as { record_count: number }).record_count).toBe(1);
  });

  it("treats a lost activation response as unknown and keeps the source fenced", async () => {
    const client = new AuthorityAdoptionClient({
      now: () => now,
      request: async () => {
        throw new Error("connection reset after send");
      }
    });
    const error = await client.complete(session(), snapshot()).catch((reason) => reason);
    expect(error).toBeInstanceOf(AuthorityAdoptionOutcomeUnknownError);
    expect(error.sourceMustRemainFenced).toBe(true);
  });

  it("resumes portable multipart files directly through presigned R2 parts", async () => {
    const content = new TextEncoder().encode("binary payload");
    const file = {
      file_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      path: "images/photo.png",
      revision: "file:1",
      content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}` as const,
      size: content.byteLength,
      media_type: "image/png",
      media_class: "image" as const,
      modified_at: "2026-07-27T00:00:00Z"
    };
    const portable = buildPortableAuthoritySnapshot({
      collectionId,
      specVersion: "0.3.0",
      resources: [{
        path: "mdbase.yaml",
        kind: "configuration",
        document: "spec_version: 0.3.0\n"
      }],
      records: [],
      files: [file]
    });
    const requests: AuthorityAdoptionRequest[] = [];
    const uploadedPartIndexes: number[] = [];
    const client = new AuthorityAdoptionClient({
      now: () => now,
      request: async (request) => {
        requests.push(request);
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/uploads")) return {
          status: 200,
          body: {
            protocol_version: 1,
            type: "file_transfer",
            transfer_id: (request.body as { transfer_id: string }).transfer_id,
            direction: "upload",
            protection: "transport_tls",
            strategy: { kind: "object_multipart", part_size: 5 },
            total_size: content.byteLength,
            expires_at: "2026-07-27T00:30:00Z",
            received: [1],
            uploaded_parts: [{ part_number: 2, etag: "etag-existing" }]
          }
        };
        if (pathname.endsWith("/parts")) {
          const body = request.body as { transfer_id: string; part_number: number };
          const partIndex = body.part_number - 1;
          const offset = partIndex * 5;
          const contentLength = Math.min(5, content.byteLength - offset);
          return {
            status: 200,
            body: {
              protocol_version: 1,
              type: "file_part",
              transfer_id: body.transfer_id,
              part_index: partIndex,
              offset,
              content_length: contentLength,
              method: "PUT",
              url: `https://r2.example/upload?part=${partIndex}&signature=secret`,
              headers: { "content-type": "application/octet-stream" },
              expires_at: "2026-07-27T00:10:00Z"
            }
          };
        }
        if (request.url.startsWith("https://r2.example/")) {
          const partIndex = Number(new URL(request.url).searchParams.get("part"));
          uploadedPartIndexes.push(partIndex);
          expect(request.rawBody).toBe(true);
          expect(request.headers?.authorization).toBeUndefined();
          expect(new Uint8Array(await (request.body as Blob).arrayBuffer())).toEqual(
            content.slice(partIndex * 5, partIndex * 5 + 5)
          );
          return { status: 200, body: {}, headers: { etag: `etag-${partIndex}` } };
        }
        if (pathname.endsWith("/commit")) {
          expect((request.body as { parts: unknown[] }).parts).toEqual([
            { part_number: 1, etag: "etag-0" },
            { part_number: 2, etag: "etag-existing" },
            { part_number: 3, etag: "etag-2" }
          ]);
          return {
            status: 200,
            body: {
              protocol_version: 1,
              type: "file_upload_committed",
              transfer_id: (request.body as { transfer_id: string }).transfer_id,
              file
            }
          };
        }
        return { status: 200, body: {} };
      }
    });
    await client.uploadSnapshot(session(), readyResponse().body as PreparedAuthorityAdoption, portable, {
      fileSource: () => content
    });

    expect((requests[0]!.body as { file_count: number; files: unknown[] })).toMatchObject({
      file_count: 1,
      files: [file]
    });
    expect(requests.map((request) => new URL(request.url).hostname)).toContain("r2.example");
    expect(uploadedPartIndexes).toEqual([0, 2]);
  });

  it("rejects an import capability redirected away from the provider endpoint", async () => {
    const client = new AuthorityAdoptionClient({
      now: () => now,
      request: async () => ({
        ...readyResponse(),
        body: {
          ...(readyResponse().body as object),
          import: {
            import_id: adoptionId,
            manifest_url: "https://evil.test/steal",
            records_url: `https://provider.test/v1/authority-imports/${adoptionId}/records`,
            files_url: `https://provider.test/v1/authority-imports/${adoptionId}/files`,
            finalize_url: `https://provider.test/v1/authority-imports/${adoptionId}/finalize`,
            access_token: "ati_a_very_long_secret"
          }
        }
      })
    });
    await expect(client.exchange(session())).rejects.toMatchObject({
      code: "invalid_authority_adoption_response"
    });
  });

  it("preserves authenticated terminal-state errors so a local fence can be released", async () => {
    const client = new AuthorityAdoptionClient({
      now: () => now,
      request: async () => ({
        status: 409,
        body: {
          error: {
            code: "authority_adoption_expired",
            message: "Collection adoption expired before hosted activation began."
          }
        }
      })
    });
    await expect(client.exchange(session())).rejects.toMatchObject({
      code: "authority_adoption_expired",
      status: 409
    });
  });
});

function snapshot(resources = [
  { path: "mdbase.yaml", kind: "configuration" as const, document: "spec_version: 0.3.0\n" }
]) {
  return buildPortableAuthoritySnapshot({
    collectionId,
    specVersion: "0.3.0",
    resources,
    records: [{
      path: "notes/one.md",
      document: "---\ntitle: One\n---\nBody\n"
    }]
  });
}

function session(): AuthorityAdoptionSession {
  return {
    controlUrl: "https://connect.test",
    adoptionId,
    credential: "adp_a_very_long_secret",
    verificationUri: `https://connect.test/adopt/${adoptionId}`,
    expiresAt: new Date(now + 1_800_000).toISOString(),
    requested: {
      collectionId,
      displayName: "Notes",
      sourceName: "Phone",
      retainMirror: true,
      mirrorName: "Phone"
    }
  };
}

function readyResponse(): AuthorityAdoptionResponse {
  const adoption = {
    id: adoptionId,
    collection_id: collectionId,
    display_name: "Notes",
    source_name: "Phone",
    retain_mirror: true,
    mirror_name: "Phone",
    state: "prepared",
    authority_epoch: 2,
    final_head: null,
    manifest_digest: null,
    source_revision: null,
    expires_at: new Date(now + 1_800_000).toISOString()
  };
  const prepared: PreparedAuthorityAdoption = {
    status: "ready",
    adoption,
    import: {
      import_id: adoptionId,
      manifest_url: `https://provider.test/v1/authority-imports/${adoptionId}/manifest`,
      records_url: `https://provider.test/v1/authority-imports/${adoptionId}/records`,
      files_url: `https://provider.test/v1/authority-imports/${adoptionId}/files`,
      finalize_url: `https://provider.test/v1/authority-imports/${adoptionId}/finalize`,
      access_token: "ati_a_very_long_secret"
    },
    staged: {
      state: "receiving",
      manifest_digest: null,
      source_revision: null,
      source_head: null
    }
  };
  return { status: 200, body: prepared };
}
