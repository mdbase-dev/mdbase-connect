import { connectFailure, connectProblem, connectSuccess } from "@mdbase-dev/connect-testing";
import { createSandbox } from "@mdbase-dev/connect-dev";
import { describe, expect, it, vi } from "vitest";

import {
  PICKLE_APPROVAL_RESPONSE_TYPE_DOCUMENT,
  PICKLE_REQUEST_CONTRACT,
  PICKLE_REQUEST_CONTRACT_DIGEST,
  PICKLE_TYPE_PACK_PROVISION,
  PickleCollection,
  PickleContractError,
  resolvePickleContract,
  type PickleFrontmatter
} from "./index.js";

const requestType = {
  name: "approval_request",
  version: 1,
  schema: { type: "object" },
  collection: { path: { folder: "requests" } },
  lifecycle: {},
  extensions: {}
};
const approvalType = {
  name: "approval_response",
  version: 1,
  schema: {
    type: "object",
    required: ["request", "decision"],
    properties: {
      request: { type: "string" },
      decision: { enum: ["approve", "reject", "revise"] },
      comment: { type: "string" }
    }
  },
  collection: {
    path: { folder: "responses" },
    links: {
      request: {
        target_type: "approval_request",
        validate_exists: true
      }
    }
  },
  lifecycle: {
    on_create: {
      set: {
        responded_at: { now: true }
      }
    }
  },
  extensions: {}
};
const contract = {
  id: PICKLE_REQUEST_CONTRACT,
  version: "1.0.0",
  digest: PICKLE_REQUEST_CONTRACT_DIGEST,
  schema: { type: "object" },
  implementations: [
    {
      type_name: requestType.name,
      type_version: 1,
      digest: `sha256:${"1".repeat(64)}`,
      fields: {
      id: "request_id",
      title: "subject",
      source: "origin",
      message: "prompt",
      kind: "kind",
      status: "status",
      priority: "priority",
      response_type: "response_type",
      created_at: "created_at",
      tags: "tags",
      links: "links",
      attachment_paths: "attachment_paths",
      metadata: "metadata"
      }
    }
  ]
};

describe("Pickle contract adapter", () => {
  it("pins every type-pack resource to its exact embedded document", async () => {
    const documents = new Map(
      PICKLE_TYPE_PACK_PROVISION.resources.map((resource) => [
        resource.source,
        resource.document
      ])
    );

    for (const resource of PICKLE_TYPE_PACK_PROVISION.manifest.resources) {
      const document = documents.get(resource.source);
      expect(document).toBeDefined();
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(document)
      );
      expect(resource.digest).toBe(
        `sha256:${Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")}`
      );
    }
  });

  it("derives lifecycle from response links and writes a typed response", async () => {
    const sandbox = createSandbox<PickleFrontmatter>({
      description: {
        display_name: "Approvals",
        spec_version: "0.3.0",
        types: [requestType, approvalType],
        contracts: [contract]
      },
      records: [
        {
          path: "requests/request-one.md",
          types: [requestType.name],
          frontmatter: {
            type: requestType.name,
            request_id: "req-one",
            subject: "Ship the release?",
            origin: "release-agent",
            prompt: "The checks passed.",
            kind: "approval",
            priority: "high",
            response_type: approvalType.name,
            created_at: "2026-07-24T01:00:00Z",
            attachment_paths: ["attachments/req-one/report.txt"]
          },
          body: "Review the release notes before deciding."
        }
      ]
    });
    const pickle = new PickleCollection(sandbox.client as never);

    const pending = await pickle.list();
    expect(pending).toEqual([
      expect.objectContaining({
        id: "req-one",
        title: "Ship the release?",
        source: "release-agent",
        state: "pending",
        responseCount: 0,
        attachments: [
          {
            path: "attachments/req-one/report.txt",
            filename: "report.txt"
          }
        ]
      })
    ]);

    await pickle.respond(
      pending[0],
      { decision: "approve", comment: "Ship it." },
      { responder: "callum" }
    );

    const answered = await pickle.list();
    expect(answered[0]).toEqual(
      expect.objectContaining({
        state: "answered",
        responseCount: 1,
        response: expect.objectContaining({
          responder: "callum",
          payload: { decision: "approve", comment: "Ship it." }
        })
      })
    );
    expect(sandbox.transport.snapshot()).toContainEqual(
      expect.objectContaining({
        path: expect.stringMatching(/^responses\/.+\.md$/),
        frontmatter: expect.objectContaining({
          type: approvalType.name,
          request: "[[requests/request-one]]",
          decision: "approve"
        })
      })
    );
    await expect(
      pickle.respond(answered[0], { decision: "reject" })
    ).rejects.toThrow("already has a response");
  });

  it("forwards one request budget through discovery, reads, and response creation", async () => {
    const sandbox = createSandbox<PickleFrontmatter>({
      description: {
        display_name: "Approvals",
        spec_version: "0.3.0",
        types: [requestType, approvalType],
        contracts: [contract]
      },
      records: [
        {
          path: "requests/request-one.md",
          types: [requestType.name],
          frontmatter: {
            type: requestType.name,
            request_id: "req-one",
            subject: "Ship the release?",
            response_type: approvalType.name
          }
        }
      ]
    });
    const describe = vi.spyOn(sandbox.client, "describe");
    const queryAll = vi.spyOn(sandbox.client, "queryAll");
    const create = vi.spyOn(sandbox.client, "create");
    const controller = new AbortController();
    const pickle = new PickleCollection(sandbox.client as never);

    const [request] = await pickle.list({
      signal: controller.signal,
      timeoutMs: 4_000
    });
    await pickle.respond(request, { decision: "approve" }, {
      responder: "callum",
      signal: controller.signal,
      timeoutMs: 7_000
    });

    expect(describe).toHaveBeenCalledWith({
      signal: controller.signal,
      timeoutMs: 4_000
    });
    expect(queryAll).toHaveBeenCalledWith(expect.any(Object), {
      signal: controller.signal,
      timeoutMs: 4_000
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        frontmatter: expect.objectContaining({ responder: "callum" })
      }),
      { signal: controller.signal, timeoutMs: 7_000 }
    );
  });

  it("returns and recovers the exact durable response mutation", async () => {
    const sandbox = createSandbox<PickleFrontmatter>({
      description: {
        display_name: "Approvals",
        spec_version: "0.3.0",
        types: [requestType, approvalType],
        contracts: [contract]
      },
      records: [
        {
          path: "requests/request-one.md",
          types: [requestType.name],
          frontmatter: {
            type: requestType.name,
            request_id: "req-one",
            subject: "Ship the release?",
            response_type: approvalType.name
          }
        }
      ]
    });
    const pickle = new PickleCollection(sandbox.client as never);
    const [request] = await pickle.list();
    const requestId = "response-request-id";
    const record = {
      path: "responses/one.md",
      frontmatter: { type: approvalType.name }
    };
    const pending = {
      requestId,
      operation: "create" as const,
      fingerprint: "fingerprint",
      status: "outcome_unknown" as const,
      createdAt: "2026-08-04T00:00:00.000Z",
      recover: vi.fn().mockResolvedValue(connectSuccess(record))
    };
    vi.spyOn(sandbox.client, "create").mockResolvedValue(
      connectFailure(
        connectProblem(
          "operation_outcome_unknown",
          "The response outcome is unknown.",
          {
            details: { request_id: requestId },
            operationOutcome: "unknown"
          }
        )
      ) as never
    );
    Object.assign(sandbox.client, {
      pendingMutations: vi.fn().mockReturnValue([pending]),
      pendingMutation: vi.fn().mockReturnValue(pending)
    });

    await expect(
      pickle.respond(request, { decision: "approve" })
    ).resolves.toEqual({ kind: "pending", requestId });
    expect(pickle.pendingResponses()).toEqual([pending]);
    await expect(pickle.recoverResponse(requestId)).resolves.toEqual({
      kind: "recorded",
      record
    });
    expect(pending.recover).toHaveBeenCalledWith({});
  });

  it("treats request status as cancellation only", async () => {
    const sandbox = createSandbox<PickleFrontmatter>({
      description: {
        types: [requestType, approvalType],
        contracts: [contract]
      },
      records: [
        {
          path: "requests/legacy.md",
          types: [requestType.name],
          frontmatter: {
            request_id: "legacy",
            subject: "Legacy marker",
            status: "answered",
            response_type: approvalType.name
          }
        },
        {
          path: "requests/cancelled.md",
          types: [requestType.name],
          frontmatter: {
            request_id: "cancelled",
            subject: "Cancelled",
            status: "cancelled",
            response_type: approvalType.name
          }
        }
      ]
    });
    const states = Object.fromEntries(
      (await new PickleCollection(sandbox.client as never).list()).map(
        (request) => [request.id, request.state]
      )
    );
    expect(states).toEqual({
      legacy: "pending",
      cancelled: "cancelled"
    });
  });

  it("rejects malformed contracts and ships portable provisioning documents", () => {
    expect(() =>
      resolvePickleContract({
        protocol_version: 1,
        collection_id: "broken",
        display_name: "Broken",
        spec_version: "0.3.0",
        operations: [],
        change_cursor: 0,
        types: [requestType],
        contracts: [
          {
            ...contract,
            implementations: [{
              ...contract.implementations[0],
              fields: { title: "__proto__.polluted" }
            }]
          }
        ]
      })
    ).toThrow(PickleContractError);
    expect(PICKLE_APPROVAL_RESPONSE_TYPE_DOCUMENT).toContain(
      "dialect: json-schema-2020-12"
    );
    expect(PICKLE_APPROVAL_RESPONSE_TYPE_DOCUMENT).toContain(
      "target_type: pickle_request"
    );
  });
});
