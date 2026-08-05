import {
  MDBASE_RECORD_CREATED_CONTRACT,
  MdbaseConnectError,
  type CollectionContractDescriptor,
  type CollectionDescription,
  type CollectionTypeDescriptor,
  type JsonObject,
  type RecordDocument,
  type QueryRecord,
  type ConnectOutcome,
  type ConnectRequestOptions,
  type MdbaseConnection,
  type PendingMutation
} from "@mdbase-dev/connect";
import { PICKLE_REQUEST_CONTRACT_DIGEST } from "./resources.js";

export {
  PICKLE_ACK_RESPONSE_TYPE_DOCUMENT,
  PICKLE_APPROVAL_RESPONSE_TYPE_DOCUMENT,
  PICKLE_REQUEST_CONTRACT_DOCUMENT,
  PICKLE_REQUEST_CONTRACT_DIGEST,
  PICKLE_TYPE_PACK_PROVISION,
  PICKLE_REQUEST_TYPE_DOCUMENT
} from "./resources.js";

export const PICKLE_REQUEST_CONTRACT = "pickle.request";
export const PICKLE_REQUEST_CONTRACT_VERSION = "1.0.0";
export const PICKLE_NOTIFICATION_CRITERION = "pickle.request.created";
export const PICKLE_NOTIFICATION_EVENT = MDBASE_RECORD_CREATED_CONTRACT;

const SYSTEM_RESPONSE_FIELDS = new Set([
  "type",
  "types",
  "id",
  "request",
  "responded_at",
  "responder",
  "attachment_paths"
]);

export type PickleRequestState =
  | "pending"
  | "answered"
  | "conflict"
  | "cancelled";

export interface PickleFrontmatter extends JsonObject {
  type?: string;
  id?: string;
  title?: string;
  source?: string;
  message?: string;
  kind?: string;
  status?: string;
  priority?: string;
  response_type?: string;
  created_at?: string;
  due_at?: string;
  dedupe_key?: string;
  tags?: unknown[];
  links?: unknown[];
  attachment_paths?: unknown[];
  metadata?: JsonObject;
}

export interface PickleContractImplementation {
  typeName: string;
  fields: Record<string, string>;
  binding?: JsonObject;
  requestType: CollectionTypeDescriptor;
}

export interface PickleContract {
  descriptor: CollectionContractDescriptor;
  implementations: PickleContractImplementation[];
}

export interface PickleLink {
  label: string;
  url?: string;
  path?: string;
}

export interface PickleAttachment {
  path: string;
  filename: string;
}

export interface PickleResponse {
  path: string;
  type: string;
  responder: string;
  respondedAt?: string;
  payload: JsonObject;
  frontmatter: JsonObject;
}

export interface PickleRequest {
  id: string;
  path: string;
  title: string;
  source: string;
  message: string;
  body: string;
  kind: string;
  priority: string;
  status?: string;
  state: PickleRequestState;
  responseCount: number;
  responseType: string;
  responseTypeDefinition?: CollectionTypeDescriptor;
  createdAt?: string;
  dueAt?: string;
  tags: string[];
  links: PickleLink[];
  attachments: PickleAttachment[];
  metadata: JsonObject;
  response?: PickleResponse;
  frontmatter: PickleFrontmatter;
}

export interface RespondOptions extends ConnectRequestOptions {
  responder?: string;
}

export type PickleResponseSubmission =
  | {
      kind: "recorded";
      record: RecordDocument<PickleFrontmatter>;
    }
  | {
      kind: "pending";
      requestId: string;
    };

export type PicklePendingResponse = PendingMutation<
  RecordDocument<PickleFrontmatter>
>;

export interface PickleClient {
  describe(
    options?: ConnectRequestOptions
  ): ReturnType<MdbaseConnection<PickleFrontmatter>["describe"]>;
  queryAll(
    input: Parameters<MdbaseConnection<PickleFrontmatter>["queryAll"]>[0],
    options?: Parameters<MdbaseConnection<PickleFrontmatter>["queryAll"]>[1]
  ): ReturnType<MdbaseConnection<PickleFrontmatter>["queryAll"]>;
  create(
    input: Parameters<MdbaseConnection<PickleFrontmatter>["create"]>[0],
    options?: ConnectRequestOptions
  ): ReturnType<MdbaseConnection<PickleFrontmatter>["create"]>;
  pendingMutations<Result = unknown>(): readonly PendingMutation<Result>[];
  pendingMutation<Result = unknown>(
    requestId: string
  ): PendingMutation<Result> | null;
}

type PickleQueryRecord = QueryRecord<PickleFrontmatter> & {
  effectiveFrontmatter: PickleFrontmatter;
};

export function resolvePickleContract(
  description: CollectionDescription
): PickleContract {
  const descriptor = description.contracts.find(
    (contract) =>
      contract.id === PICKLE_REQUEST_CONTRACT &&
      contract.version === PICKLE_REQUEST_CONTRACT_VERSION &&
      contract.digest === PICKLE_REQUEST_CONTRACT_DIGEST
  );
  if (!descriptor) {
    throw new PickleContractError(
      "This collection does not provide the Pickle request contract."
    );
  }
  const implementations = descriptor.implementations.map((implementation) => {
    const requestType = description.types.find(
      (candidate) => candidate.name === implementation.typeName
    );
    if (!requestType)
      throw new PickleContractError(
        `The Pickle request type ${implementation.typeName} is missing from this collection.`
      );
    return {
      typeName: implementation.typeName,
      fields: parseFields(implementation.fields),
      binding: implementation.binding,
      requestType
    };
  });
  if (!implementations.length)
    throw new PickleContractError(
      "The Pickle request contract has no type implementations."
    );
  return {
    descriptor,
    implementations
  };
}

export class PickleCollection {
  private description: CollectionDescription | null = null;
  private contract: PickleContract | null = null;

  constructor(private readonly connect: PickleClient) {}

  async describe(): Promise<{
    collection: CollectionDescription;
    contract: PickleContract;
  }>;
  async describe(options: ConnectRequestOptions): Promise<{
    collection: CollectionDescription;
    contract: PickleContract;
  }>;
  async describe(options: ConnectRequestOptions = {}): Promise<{
    collection: CollectionDescription;
    contract: PickleContract;
  }> {
    this.description ??= requireOutcome(
      await this.connect.describe(options)
    );
    this.contract ??= resolvePickleContract(this.description);
    return { collection: this.description, contract: this.contract };
  }

  async list(options: ConnectRequestOptions = {}): Promise<PickleRequest[]> {
    const { collection, contract } = await this.describe(options);
    const requestQuery = requireOutcome(
      await this.connect.queryAll(
        {
          types: contract.implementations.map(({ typeName }) => typeName),
          includeBody: true,
          frontmatterMode: "effective"
        },
        options
      )
    );
    const requests = requestQuery.results.map(requireEffectiveFrontmatter);
    const responseTypes = [
      ...new Set(
        requests
          .map((record) => {
            const implementation = implementationForRecord(contract, record);
            return stringField(
              record.effectiveFrontmatter,
              role(implementation, "response_type", "response_type")
            );
          })
          .filter(Boolean)
      )
    ];
    const responses = responseTypes.length
      ? (
          requireOutcome(
            await this.connect.queryAll(
              {
                types: responseTypes,
                includeBody: true,
                frontmatterMode: "effective"
              },
              options
            )
          )
        ).results.map(requireEffectiveFrontmatter)
      : [];
    return requests
      .map((record) =>
        normalizeRequest(record, responses, collection, contract)
      )
      .sort((left, right) =>
        (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
      );
  }

  async respond(
    request: PickleRequest,
    payload: JsonObject,
    options: RespondOptions = {}
  ): Promise<PickleResponseSubmission> {
    if (request.state !== "pending") {
      throw new PickleContractError(
        request.state === "conflict"
          ? "Resolve the conflicting responses in the collection first."
          : "This request already has a response."
      );
    }
    const responseType = request.responseTypeDefinition;
    if (!responseType) {
      throw new PickleContractError(
        `The response type ${request.responseType} is unavailable.`
      );
    }
    const responseFolder =
      stringField(asObject(responseType.collection?.path), "folder") ||
      "responses";
    const { responder, ...requestOptions } = options;
    const frontmatter: PickleFrontmatter = {
      ...payload,
      type: request.responseType,
      request: requestLink(request.path),
      responder: responder?.trim() || "human"
    };
    const created = await this.connect.create(
      {
        type: request.responseType,
        path: `${trimSlashes(responseFolder)}/${crypto.randomUUID()}.md`,
        frontmatter,
        body: ""
      },
      requestOptions
    );
    return responseSubmission(created);
  }

  pendingResponses(): readonly PicklePendingResponse[] {
    return this.connect
      .pendingMutations<RecordDocument<PickleFrontmatter>>()
      .filter((mutation) => mutation.operation === "create");
  }

  async recoverResponse(
    requestId: string,
    options: ConnectRequestOptions = {}
  ): Promise<PickleResponseSubmission> {
    const pending = this.connect.pendingMutation<
      RecordDocument<PickleFrontmatter>
    >(requestId);
    if (!pending || pending.operation !== "create") {
      throw new PickleContractError(
        "This pending Pickle response is no longer available for recovery."
      );
    }
    return responseSubmission(await pending.recover(options));
  }
}

export class PickleContractError extends Error {}

function responseSubmission(
  outcome: ConnectOutcome<RecordDocument<PickleFrontmatter>>
): PickleResponseSubmission {
  if (outcome.ok) return { kind: "recorded", record: outcome.value };
  const requestId =
    outcome.problem.code === "operation_outcome_unknown" &&
    outcome.problem.details &&
    typeof outcome.problem.details === "object" &&
    "request_id" in outcome.problem.details &&
    typeof outcome.problem.details.request_id === "string"
      ? outcome.problem.details.request_id
      : null;
  if (requestId) return { kind: "pending", requestId };
  throw new MdbaseConnectError(outcome.problem);
}

function normalizeRequest(
  record: PickleQueryRecord,
  responseRecords: PickleQueryRecord[],
  description: CollectionDescription,
  contract: PickleContract
): PickleRequest {
  const implementation = implementationForRecord(contract, record);
  const responseType =
    stringField(
      record.effectiveFrontmatter,
      role(implementation, "response_type", "response_type")
    ) || "pickle_response_approval";
  const linked = responseRecords.filter((candidate) =>
    linkTargets(candidate.effectiveFrontmatter.request, record.path)
  );
  const status = stringField(
    record.effectiveFrontmatter,
    role(implementation, "status", "status")
  );
  const state: PickleRequestState =
    status === "cancelled"
      ? "cancelled"
      : linked.length === 0
        ? "pending"
        : linked.length === 1
          ? "answered"
          : "conflict";
  const response =
    linked.length === 1 ? normalizeResponse(linked[0]) : undefined;
  return {
    id:
      stringField(record.effectiveFrontmatter, role(implementation, "id", "id")) ||
      record.path,
    path: record.path,
    title:
      stringField(record.effectiveFrontmatter, role(implementation, "title", "title")) ||
      record.path,
    source:
      stringField(record.effectiveFrontmatter, role(implementation, "source", "source")) ||
      "agent",
    message: stringField(
      record.effectiveFrontmatter,
      role(implementation, "message", "message")
    ),
    body: record.body ?? "",
    kind:
      stringField(record.effectiveFrontmatter, role(implementation, "kind", "kind")) ||
      "approval",
    priority:
      stringField(
        record.effectiveFrontmatter,
        role(implementation, "priority", "priority")
      ) || "normal",
    status: status || undefined,
    state,
    responseCount: linked.length,
    responseType,
    responseTypeDefinition: description.types.find(
      (candidate) => candidate.name === responseType
    ),
    createdAt:
      stringField(
        record.effectiveFrontmatter,
        role(implementation, "created_at", "created_at")
      ) || undefined,
    dueAt: stringField(record.effectiveFrontmatter, "due_at") || undefined,
    tags: stringList(
      getField(record.effectiveFrontmatter, role(implementation, "tags", "tags"))
    ),
    links: links(
      getField(record.effectiveFrontmatter, role(implementation, "links", "links"))
    ),
    attachments: attachments(
      getField(
        record.effectiveFrontmatter,
        role(implementation, "attachment_paths", "attachment_paths")
      )
    ),
    metadata:
      asObject(
        getField(
          record.effectiveFrontmatter,
          role(implementation, "metadata", "metadata")
        )
      ) ?? {},
    response,
    frontmatter: record.effectiveFrontmatter
  };
}

function normalizeResponse(
  record: PickleQueryRecord
): PickleResponse {
  const frontmatter = record.effectiveFrontmatter;
  return {
    path: record.path,
    type:
      stringField(frontmatter, "type") || record.types[0] || "pickle_response",
    responder: stringField(frontmatter, "responder") || "human",
    respondedAt: stringField(frontmatter, "responded_at") || undefined,
    payload: Object.fromEntries(
      Object.entries(frontmatter).filter(
        ([key]) => !SYSTEM_RESPONSE_FIELDS.has(key)
      )
    ),
    frontmatter
  };
}

function requireEffectiveFrontmatter(
  record: QueryRecord<PickleFrontmatter>
): PickleQueryRecord {
  if (!record.effectiveFrontmatter) {
    throw new PickleContractError(
      `Query result ${record.path} omitted effectiveFrontmatter.`
    );
  }
  return record as PickleQueryRecord;
}

function requireOutcome<Value>(outcome: ConnectOutcome<Value>): Value {
  if (!outcome.ok) throw new MdbaseConnectError(outcome.problem);
  return outcome.value;
}

function parseFields(value: Record<string, string>): Record<string, string> {
  if (
    !Object.values(value).every(
      (field) => typeof field === "string" && validFieldPath(field)
    )
  )
    throw new PickleContractError("The Pickle request contract is malformed.");
  return value;
}

function role(
  implementation: PickleContractImplementation,
  name: string,
  fallback: string
): string {
  return implementation.fields[name] ?? fallback;
}

function implementationForRecord(
  contract: PickleContract,
  record: Pick<QueryRecord, "path" | "types">
): PickleContractImplementation {
  const matches = contract.implementations.filter((implementation) =>
    record.types.includes(implementation.typeName)
  );
  if (matches.length !== 1)
    throw new PickleContractError(
      `Pickle request ${record.path} matches ${matches.length} contract implementations; exactly one is required.`
    );
  return matches[0];
}

function getField(value: JsonObject, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    const object = asObject(current);
    if (!object) return undefined;
    current = object[segment];
  }
  return current;
}

function stringField(value: unknown, path: string): string {
  const field = asObject(value) ? getField(value as JsonObject, path) : undefined;
  return typeof field === "string" ? field.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function links(value: unknown): PickleLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const object = asObject(item);
    if (!object) return [];
    const label = stringField(object, "label");
    const url = stringField(object, "url");
    const path = stringField(object, "path");
    return label || url || path
      ? [{ label: label || url || path, ...(url ? { url } : {}), ...(path ? { path } : {}) }]
      : [];
  });
}

function attachments(value: unknown): PickleAttachment[] {
  return stringList(value).map((path) => ({
    path,
    filename: path.split("/").at(-1) || path
  }));
}

function requestLink(path: string): string {
  return `[[${path.replace(/\.md$/i, "")}]]`;
}

function linkTargets(value: unknown, requestPath: string): boolean {
  if (typeof value !== "string") return false;
  const target = normalizeLink(value);
  const request = normalizeLink(requestPath);
  if (!target || !request) return false;
  return (
    target === request ||
    (!target.includes("/") && target === request.split("/").at(-1))
  );
}

function normalizeLink(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("[[") && normalized.endsWith("]]")) {
    normalized = normalized.slice(2, -2);
  } else {
    const markdown = normalized.match(/^\[[^\]]*\]\(([^)]+)\)$/);
    if (markdown) normalized = markdown[1];
  }
  normalized = normalized.split("|", 1)[0].split("#", 1)[0];
  return normalized
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .replace(/\.md$/i, "");
}

function validFieldPath(value: string): boolean {
  return value
    .split(".")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "__proto__" &&
        part !== "prototype" &&
        part !== "constructor"
    );
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
