import { describe, expect, it } from "vitest";
import { MdbaseError } from "@mdbase-dev/sdk";
import { MdbaseConnectError, connectProblem } from "./connect-types";
import { editorPermissions, gatewayError, missingCoreCapabilities, missingTypeCapabilities } from "./gateway";

describe("gateway helpers", () => {
  it("partitions missing capabilities into core and type-definition buckets", () => {
    const connection = {
      collectionId: "col-1",
      operations: ["describe", "read", "query"],
      missingCapabilities: ["records.update", "files.read", "definitions.read", "other.cap"]
    };
    expect(missingCoreCapabilities(connection)).toEqual(["records.update", "files.read"]);
    expect(missingTypeCapabilities(connection)).toEqual(["definitions.read"]);
  });

  it("derives editor permissions from granted operations and file actions", () => {
    expect(editorPermissions(null)).toEqual({
      canCreateNotes: false,
      canEditNotes: false,
      canRenameNotes: false,
      canDeleteNotes: false,
      canManageTypes: false,
      canInstallTypes: false,
      canAttachFiles: false
    });
    expect(editorPermissions({
      collectionId: "col-1",
      operations: ["create", "update", "rename", "delete", "create_type", "update_type", "apply_type_pack"],
      fileActions: ["list", "read", "add"]
    })).toEqual({
      canCreateNotes: true,
      canEditNotes: true,
      canRenameNotes: true,
      canDeleteNotes: true,
      canManageTypes: true,
      canInstallTypes: true,
      canAttachFiles: true
    });
  });

  it("translates connect and sdk errors into plain user copy", () => {
    expect(gatewayError(new MdbaseConnectError(connectProblem("connector_offline", "offline")))).toContain("offline");
    expect(gatewayError(new MdbaseConnectError(connectProblem("application_reauthorization_required", "revoked")))).toContain("authorization");
    expect(gatewayError(new MdbaseError({ code: "forbidden", recovery: "reauthorize", message: "revoked" }))).toContain("authorization");
    expect(gatewayError(new Error("boom"))).toBe("boom");
  });

  it("formats validation issue details from native MdbaseError rejections", () => {
    const error = new MdbaseError({
      code: "invalid_record",
      recovery: "fix_request",
      message: "`tasks/buy-milk.md` would not be valid",
      issues: [
        {
          code: "schema_required",
          severity: "error",
          message: "required property `dateCreated` is missing",
          details: { location: "/dateCreated", type: "task" }
        },
        {
          code: "schema_enum",
          severity: "error",
          message: "the value is not one of the allowed values",
          details: { location: "/status", type: "task" }
        },
        {
          code: "unknown_type",
          severity: "warning",
          message: "unknown type `ghost`",
          details: { location: "/types", type: "ghost" }
        }
      ]
    });

    expect(gatewayError(error)).toBe(
      "required property `dateCreated` is missing; status: the value is not one of the allowed values"
    );
  });

  it("formats validation diagnostics attached to Connect problems", () => {
    const error = new MdbaseConnectError(connectProblem("operation_invalid", "`tasks/buy-milk.md` would not be valid", {
      details: {
        diagnostics: [
          {
            code: "schema_type",
            severity: "error",
            message: "expected string",
            location: "/priority"
          }
        ]
      }
    }));

    expect(gatewayError(error)).toBe("priority: expected string");
  });
});
