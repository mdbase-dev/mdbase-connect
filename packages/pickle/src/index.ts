import type {
  CollectionContractDescriptor,
  CollectionDescription,
  CollectionTypeDescriptor,
  JsonObject,
  RecordDocument,
  QueryRecord
} from "@mdbase/connect-protocol";
import type { MdbaseConnection, QueryResult } from "@mdbase/connect";

export {
  PICKLE_ACK_RESPONSE_TYPE_DOCUMENT,
  PICKLE_APPROVAL_RESPONSE_TYPE_DOCUMENT,
  PICKLE_PROVISION_TYPES,
  PICKLE_REQUEST_TYPE_DOCUMENT
} from "./resources.js";

export const PICKLE_REQUEST_CONTRACT = "pickle.request";
export const PICKLE_NOTIFICATION_CRITERION = "pickle.request.created";

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

export interface PickleContractConfiguration extends JsonObject {
  contract: typeof PICKLE_REQUEST_CONTRACT;
  version: number;
  field_roles: Record<string, string>;
}

export interface PickleContract {
  descriptor: CollectionContractDescriptor;
  configuration: PickleContractConfiguration;
  requestType: CollectionTypeDescriptor;
  requestTypeName: string;
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

export interface RespondOptions {
  responder?: string;
}

export interface PickleClient {
  describe(): Promise<CollectionDescription>;
  queryAll(
    input: Parameters<MdbaseConnection<PickleFrontmatter>["queryAll"]>[0]
  ): Promise<QueryResult<PickleFrontmatter>>;
  create(
    input: Parameters<MdbaseConnection<PickleFrontmatter>["create"]>[0]
  ): ReturnType<MdbaseConnection<PickleFrontmatter>["create"]>;
}

type PickleQueryRecord = QueryRecord<PickleFrontmatter> & {
  effective_frontmatter: PickleFrontmatter;
};

export function resolvePickleContract(
  description: CollectionDescription
): PickleContract {
  const descriptor = description.contracts.find(
    (contract) => contract.id === PICKLE_REQUEST_CONTRACT
  );
  if (!descriptor) {
    throw new PickleContractError(
      "This collection does not provide the Pickle request contract."
    );
  }
  const configuration = parseConfiguration(descriptor.configuration);
  const requestType = description.types.find(
    (candidate) => candidate.name === descriptor.type_name
  );
  if (!requestType) {
    throw new PickleContractError(
      "The Pickle request type is missing from this collection."
    );
  }
  return {
    descriptor,
    configuration,
    requestType,
    requestTypeName: descriptor.type_name
  };
}

export class PickleCollection {
  private description: CollectionDescription | null = null;
  private contract: PickleContract | null = null;

  constructor(private readonly connect: PickleClient) {}

  async describe(): Promise<{
    collection: CollectionDescription;
    contract: PickleContract;
  }> {
    this.description ??= await this.connect.describe();
    this.contract ??= resolvePickleContract(this.description);
    return { collection: this.description, contract: this.contract };
  }

  async list(): Promise<PickleRequest[]> {
    const { collection, contract } = await this.describe();
    const requestQuery = await this.connect.queryAll({
      types: [contract.requestTypeName],
      include_body: true,
      frontmatter_mode: "effective"
    });
    const requests = requestQuery.results.map(requireEffectiveFrontmatter);
    const responseTypes = [
      ...new Set(
        requests
          .map((record) =>
            stringField(
              record.effective_frontmatter,
              role(contract, "response_type", "response_type")
            )
          )
          .filter(Boolean)
      )
    ];
    const responses = responseTypes.length
      ? (
          await this.connect.queryAll({
            types: responseTypes,
            include_body: true,
            frontmatter_mode: "effective"
          })
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
  ): Promise<RecordDocument<PickleFrontmatter>> {
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
    const frontmatter: PickleFrontmatter = {
      ...payload,
      type: request.responseType,
      request: requestLink(request.path),
      responder: options.responder?.trim() || "human"
    };
    const created = await this.connect.create({
      type: request.responseType,
      path: `${trimSlashes(responseFolder)}/${crypto.randomUUID()}.md`,
      frontmatter,
      body: ""
    });
    assertValid(created);
    return created.result;
  }
}

export class PickleContractError extends Error {}

function normalizeRequest(
  record: PickleQueryRecord,
  responseRecords: PickleQueryRecord[],
  description: CollectionDescription,
  contract: PickleContract
): PickleRequest {
  const responseType =
    stringField(
      record.effective_frontmatter,
      role(contract, "response_type", "response_type")
    ) || "pickle_response_approval";
  const linked = responseRecords.filter((candidate) =>
    linkTargets(candidate.effective_frontmatter.request, record.path)
  );
  const status = stringField(
    record.effective_frontmatter,
    role(contract, "status", "status")
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
      stringField(record.effective_frontmatter, role(contract, "id", "id")) ||
      record.path,
    path: record.path,
    title:
      stringField(record.effective_frontmatter, role(contract, "title", "title")) ||
      record.path,
    source:
      stringField(record.effective_frontmatter, role(contract, "source", "source")) ||
      "agent",
    message: stringField(
      record.effective_frontmatter,
      role(contract, "message", "message")
    ),
    body: record.body ?? "",
    kind:
      stringField(record.effective_frontmatter, role(contract, "kind", "kind")) ||
      "approval",
    priority:
      stringField(
        record.effective_frontmatter,
        role(contract, "priority", "priority")
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
        record.effective_frontmatter,
        role(contract, "created_at", "created_at")
      ) || undefined,
    dueAt: stringField(record.effective_frontmatter, "due_at") || undefined,
    tags: stringList(
      getField(record.effective_frontmatter, role(contract, "tags", "tags"))
    ),
    links: links(
      getField(record.effective_frontmatter, role(contract, "links", "links"))
    ),
    attachments: attachments(
      getField(
        record.effective_frontmatter,
        role(contract, "attachment_paths", "attachment_paths")
      )
    ),
    metadata:
      asObject(
        getField(
          record.effective_frontmatter,
          role(contract, "metadata", "metadata")
        )
      ) ?? {},
    response,
    frontmatter: record.effective_frontmatter
  };
}

function normalizeResponse(
  record: PickleQueryRecord
): PickleResponse {
  const frontmatter = record.effective_frontmatter;
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
  if (!record.effective_frontmatter) {
    throw new PickleContractError(
      `Query result ${record.path} omitted effective_frontmatter.`
    );
  }
  return record as PickleQueryRecord;
}

function parseConfiguration(value: JsonObject): PickleContractConfiguration {
  const roles = asObject(value.field_roles);
  if (
    value.contract !== PICKLE_REQUEST_CONTRACT ||
    typeof value.version !== "number" ||
    !roles ||
    !Object.values(roles).every(
      (field) => typeof field === "string" && validFieldPath(field)
    )
  ) {
    throw new PickleContractError("The Pickle request contract is malformed.");
  }
  return value as PickleContractConfiguration;
}

function role(
  contract: PickleContract,
  name: string,
  fallback: string
): string {
  return contract.configuration.field_roles[name] ?? fallback;
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

function assertValid(value: {
  valid: boolean;
  diagnostics: Array<{ message: string }>;
}): void {
  if (value.valid) return;
  throw new PickleContractError(
    value.diagnostics[0]?.message ?? "Pickle operation failed."
  );
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
