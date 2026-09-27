import type { AccountIdentity, AccountProfile, CollectionMemberProfile, JsonObject } from "@mdbase-dev/connect-protocol";
import { connectError, MdbaseConnectError } from "./errors.js";
import type { CollectionDescription, ConnectRequestOptions, QueryInput, QueryPage, QueryPagesOptions } from "./operation-types.js";
import { connectFetch, decodeJsonResponse } from "./runtime-utils.js";
import { withRequestBudget } from "./request-budget.js";
import {
  captureConnectOutcome,
  COLLECTION_QUERY_PROBLEM_CODES,
  COMMON_OPERATION_PROBLEM_CODES,
  type CollectionQueryProblemCode,
  type CommonOperationProblemCode,
  type ConnectOutcome
} from "./outcomes.js";

export const PERSON_CONTRACT = { id: "mdbase.person", version: "2.0.0" } as const;

/** The authenticated account, plus where it manages its person record. */
export interface CurrentAccount extends AccountProfile {
  /** A navigation route that may change; never derive one from `issuer`. */
  personSettingsUrl?: string;
}

/** One record's normalized `mdbase.person` projection. Other records refer to it by link. */
export interface PersonRecord {
  path: string;
  name: string;
  identities: AccountIdentity[];
  /** Every type through which this record implements the Person contract. */
  typeNames: string[];
}

/** A Person record that could not be projected; reported, never guessed. */
export interface InvalidPersonRecord {
  path: string;
  reason: string;
}

/**
 * How the current account resolves to a person record. Resolution matches
 * exact issuer/subject pairs only: no normalization, email, or name matching.
 */
export type PersonResolution =
  | { status: "linked"; person: PersonRecord }
  | { status: "unlinked" }
  /** Several records claim this account. */
  | { status: "ambiguous"; paths: string[] }
  /** A record that fails projection claims this account; fix it before relying on it. */
  | { status: "invalid"; paths: string[] };

export interface PeopleDirectory {
  account: CurrentAccount;
  me: PersonResolution;
  people: PersonRecord[];
  invalid: InvalidPersonRecord[];
  /** Absent when not requested or not approved; never an empty stand-in. */
  members?: CollectionMemberProfile[];
}

export interface PeopleDirectoryOptions extends ConnectRequestOptions {
  /**
   * `"if-approved"` includes members when the grant allows it and omits them
   * when the user declined that optional permission.
   */
  members?: "require" | "if-approved" | "omit";
}

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
    if (response.status === 403) throw connectError("access_denied", "This application was not approved to read this identity information.");
    if (!response.ok) throw connectError("temporarily_unavailable", "Account identity information is unavailable.");
    return decodeJsonResponse(response, "invalid_operation_response", "Connect returned invalid identity information.");
  });
}

export interface PeopleClientContext {
  request(resource: "identity" | "members", options?: ConnectRequestOptions): Promise<unknown>;
  describe(options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionDescription, CollectionQueryProblemCode>>;
  queryPages(input: QueryInput, options: QueryPagesOptions): AsyncIterable<ConnectOutcome<QueryPage, CollectionQueryProblemCode>>;
}

/** Account metadata and the collection's person records, resolved one way for every app. */
export class MdbasePeopleClient {
  constructor(private readonly context: PeopleClientContext) {}

  current(options?: ConnectRequestOptions): Promise<ConnectOutcome<CurrentAccount, CommonOperationProblemCode>> {
    return captureConnectOutcome(() => this.readCurrent(options), COMMON_OPERATION_PROBLEM_CODES);
  }

  members(options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionMemberProfile[], CommonOperationProblemCode>> {
    return captureConnectOutcome(() => this.readMembers(options), COMMON_OPERATION_PROBLEM_CODES);
  }

  /**
   * Reads every record of every type implementing `mdbase.person` 2.0.0, across
   * all pages, and resolves the current account. Any failed read fails the
   * whole directory: a partial directory is never presented as complete.
   */
  directory(options: PeopleDirectoryOptions = {}): Promise<ConnectOutcome<PeopleDirectory, CollectionQueryProblemCode>> {
    return captureConnectOutcome(async () => {
      const { members: memberMode = "if-approved", ...request } = options;
      const [account, members, records] = await Promise.all([
        this.readCurrent(request),
        memberMode === "omit" ? undefined : this.readMembers(request).catch((error: unknown) => {
          if (memberMode === "if-approved" && error instanceof MdbaseConnectError && error.code === "access_denied") return undefined;
          throw error;
        }),
        this.readRecords(request)
      ]);
      return {
        account,
        me: resolvePerson(records, account),
        people: records.people,
        invalid: records.invalid.map(({ path, reason }) => ({ path, reason })),
        ...(members ? { members } : {})
      };
    }, COLLECTION_QUERY_PROBLEM_CODES);
  }

  private async readCurrent(options?: ConnectRequestOptions): Promise<CurrentAccount> {
    const value = await this.context.request("identity", options);
    const account = profile(value);
    const settings = (value as { person_settings_url?: unknown }).person_settings_url;
    if (settings === undefined) return account;
    if (typeof settings !== "string" || !isHttpUrl(settings)) throw invalidResponse();
    return { ...account, personSettingsUrl: settings };
  }

  private async readMembers(options?: ConnectRequestOptions): Promise<CollectionMemberProfile[]> {
    const body = await this.context.request("members", options);
    if (!body || typeof body !== "object" || !("members" in body) || !Array.isArray(body.members)) throw invalidResponse();
    return body.members.map((member: unknown) => {
      const account = profile(member);
      if (!member || typeof member !== "object" || !("role" in member)
        || (member.role !== "owner" && member.role !== "editor" && member.role !== "viewer")) throw invalidResponse();
      return { ...account, role: member.role };
    });
  }

  private async readRecords(options: ConnectRequestOptions) {
    const description = unwrap(await this.context.describe(options));
    const contract = description.contracts.find((candidate) =>
      candidate.id === PERSON_CONTRACT.id && candidate.version === PERSON_CONTRACT.version);
    const projections = new Map<string, Array<{ typeName: string; value: JsonObject }>>();
    for (const implementation of contract?.implementations ?? []) {
      for await (const outcome of this.context.queryPages(
        { contract: { ...PERSON_CONTRACT, type: implementation.typeName } },
        { signal: options.signal, pageSize: 200 }
      )) {
        for (const record of unwrap(outcome).results) {
          const entries = projections.get(record.path) ?? [];
          entries.push({ typeName: implementation.typeName, value: record.frontmatter ?? {} });
          projections.set(record.path, entries);
        }
      }
    }
    const people: PersonRecord[] = [];
    const invalid: Array<InvalidPersonRecord & { claims: AccountIdentity[] }> = [];
    for (const [path, entries] of projections) {
      const parsed = entries.map((entry) => parsePerson(entry.value));
      const first = parsed[0];
      const reason = parsed.find((result) => "reason" in result);
      if (reason && "reason" in reason) {
        invalid.push({ path, reason: reason.reason, claims: entries.flatMap((entry) => looseIdentities(entry.value)) });
      } else if (parsed.some((result) => JSON.stringify(result) !== JSON.stringify(first))) {
        invalid.push({ path, reason: "Its Person implementations project different values.", claims: entries.flatMap((entry) => looseIdentities(entry.value)) });
      } else if (first && !("reason" in first)) {
        people.push({ path, ...first, typeNames: entries.map((entry) => entry.typeName).sort() });
      }
    }
    const byPath = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path);
    return { people: people.sort(byPath), invalid: invalid.sort(byPath) };
  }
}

function resolvePerson(
  records: { people: PersonRecord[]; invalid: Array<InvalidPersonRecord & { claims: AccountIdentity[] }> },
  account: AccountIdentity
): PersonResolution {
  const invalid = records.invalid.filter((record) => record.claims.some((claim) => sameIdentity(claim, account)));
  if (invalid.length) return { status: "invalid", paths: invalid.map((record) => record.path) };
  const matches = records.people.filter((person) => person.identities.some((identity) => sameIdentity(identity, account)));
  if (matches.length === 0) return { status: "unlinked" };
  if (matches.length > 1) return { status: "ambiguous", paths: matches.map((person) => person.path) };
  return { status: "linked", person: matches[0] };
}

export function sameIdentity(left: AccountIdentity, right: AccountIdentity): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}

function parsePerson(value: JsonObject): Omit<PersonRecord, "path" | "typeNames"> | { reason: string } {
  const { name, identities = [] } = value;
  if (typeof name !== "string" || !name.trim()) return { reason: "It needs a non-blank name." };
  if (!Array.isArray(identities)) return { reason: "Its account identities must be a list." };
  const parsed: AccountIdentity[] = [];
  for (const identity of identities) {
    if (!identity || typeof identity !== "object" || Array.isArray(identity)
      || typeof identity.issuer !== "string" || typeof identity.subject !== "string" || !identity.subject.trim()) {
      return { reason: "Each account identity needs an exact issuer and subject." };
    }
    parsed.push({ issuer: identity.issuer, subject: identity.subject });
  }
  return { name, identities: parsed };
}

/** Identities an invalid record still appears to claim, so it can block resolution. */
function looseIdentities(value: JsonObject): AccountIdentity[] {
  const identities: unknown[] = Array.isArray(value.identities) ? value.identities : [];
  return identities.flatMap((identity): AccountIdentity[] =>
    identity && typeof identity === "object" && !Array.isArray(identity)
      && "issuer" in identity && "subject" in identity
      && typeof identity.issuer === "string" && typeof identity.subject === "string"
      ? [{ issuer: identity.issuer, subject: identity.subject }] : []);
}

function unwrap<Value>(outcome: ConnectOutcome<Value, CollectionQueryProblemCode>): Value {
  if (!outcome.ok) throw new MdbaseConnectError(outcome.problem);
  return outcome.value;
}

function profile(value: unknown): AccountProfile {
  if (!value || typeof value !== "object" || !("issuer" in value) || !("subject" in value) || !("name" in value)
    || typeof value.issuer !== "string" || typeof value.subject !== "string" || typeof value.name !== "string"
    || !value.subject.trim() || !value.name.trim() || !isHttpUrl(value.issuer)) throw invalidResponse();
  return { issuer: value.issuer, subject: value.subject, name: value.name };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function invalidResponse() {
  return connectError("invalid_operation_response", "Connect returned invalid identity information.");
}
