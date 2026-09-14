import type { AccountProfile, CollectionMemberProfile } from "@mdbase-dev/connect-protocol";
import { connectError } from "./errors.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { captureConnectOutcome, COMMON_OPERATION_PROBLEM_CODES, type CommonOperationProblemCode, type ConnectOutcome } from "./outcomes.js";

/** Account metadata, independent of editable person records and collection routing. */
export class MdbasePeopleClient {
  constructor(private readonly request: (
    resource: "identity" | "members", options?: ConnectRequestOptions
  ) => Promise<unknown>) {}

  current(options?: ConnectRequestOptions): Promise<ConnectOutcome<AccountProfile, CommonOperationProblemCode>> {
    return captureConnectOutcome(async () => profile(await this.request("identity", options)), COMMON_OPERATION_PROBLEM_CODES);
  }

  members(options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionMemberProfile[], CommonOperationProblemCode>> {
    return captureConnectOutcome(async () => {
      const body = await this.request("members", options);
      if (!body || typeof body !== "object" || !("members" in body) || !Array.isArray(body.members)) throw invalidResponse();
      return body.members.map((member: unknown) => {
        const account = profile(member);
        if (!member || typeof member !== "object" || !("role" in member)
          || (member.role !== "owner" && member.role !== "editor" && member.role !== "viewer")) throw invalidResponse();
        return { ...account, role: member.role };
      });
    }, COMMON_OPERATION_PROBLEM_CODES);
  }
}

function profile(value: unknown): AccountProfile {
  if (!value || typeof value !== "object" || !("issuer" in value) || !("subject" in value) || !("name" in value)
    || typeof value.issuer !== "string" || typeof value.subject !== "string" || typeof value.name !== "string"
    || !value.subject.trim() || !value.name.trim()) throw invalidResponse();
  try {
    const issuer = new URL(value.issuer);
    if (issuer.protocol !== "https:" && issuer.protocol !== "http:") throw invalidResponse();
  } catch { throw invalidResponse(); }
  return { issuer: value.issuer, subject: value.subject, name: value.name };
}

function invalidResponse() {
  return connectError("invalid_operation_response", "Connect returned invalid identity information.");
}
