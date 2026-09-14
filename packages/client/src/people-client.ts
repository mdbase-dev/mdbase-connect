import type { AccountProfile, CollectionMemberProfile } from "@mdbase-dev/connect-protocol";
import { connectError } from "./errors.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { connectFetch, decodeJsonResponse } from "./runtime-utils.js";
import { withRequestBudget } from "./request-budget.js";
import { captureConnectOutcome, COMMON_OPERATION_PROBLEM_CODES, type CommonOperationProblemCode, type ConnectOutcome } from "./outcomes.js";

export function requestPeople(resource: "identity" | "members", options: ConnectRequestOptions, context: {
  serverUrl: string; collectionId: string; requestMs: number | null;
  authorizedToken(signal: AbortSignal): Promise<{ accessToken: string } | null>;
}): Promise<unknown> {
  return withRequestBudget(options, context.requestMs, async (budget) => {
    const token = await context.authorizedToken(budget.signal);
    if (!token) throw connectError("not_authorized", "Authorize this collection before reading people.");
    const response = await connectFetch(
      `${context.serverUrl}/v1/authorities/${encodeURIComponent(context.collectionId)}/${resource}`,
      { headers: { authorization: `Bearer ${token.accessToken}` }, signal: budget.signal, credentials: "omit", cache: "no-store", redirect: "error" },
      "temporarily_unavailable", "Account identity information is unavailable."
    );
    if (response.status === 404) throw connectError("unsupported_operation", "This Connect server does not support people discovery.");
    if (response.status === 401) throw connectError("authorization_expired", "The application authorization is no longer active.");
    if (response.status === 403) throw connectError("access_denied", "This application was not approved to read this identity information. Reconnect it with a declaration that requests People access.");
    if (!response.ok) throw connectError("temporarily_unavailable", "Account identity information is unavailable.");
    return decodeJsonResponse(response, "invalid_operation_response", "Connect returned invalid identity information.");
  });
}

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
