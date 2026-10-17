/** Account metadata plus canonical native mdbase.person projections. */
import type { MdbaseClient } from "./client.js";
import { uuidToBytes } from "./codec.js";
import { mdbaseError, isMdbaseError } from "./errors.js";
import type { ContractProjection } from "./contract-query.js";
import type { Session } from "./session.js";

export const PERSON_CONTRACT = Object.freeze({ id: "mdbase.person", version: "2.0.0" });
export interface AccountIdentity { issuer: string; subject: string }
export interface AccountProfile extends AccountIdentity { name: string; accountId?: string }
export interface CurrentAccount extends AccountProfile { personSettingsUrl?: string }
export interface CollectionMemberProfile extends AccountProfile { role: "owner" | "editor" | "viewer" }
export interface PersonRecord { id: string; path: string; name: string; identities: AccountIdentity[]; typeNames: string[] }
export interface InvalidPersonRecord { id: string; path: string; reason: string }
export type PersonResolution =
  | { status: "linked"; person: PersonRecord }
  | { status: "unlinked" }
  | { status: "ambiguous" | "invalid"; paths: string[] };
export interface PeopleDirectory {
  account: CurrentAccount; me: PersonResolution; people: PersonRecord[]; invalid: InvalidPersonRecord[];
  /** Missing only when omitted or that specific optional permission was declined. */
  members?: CollectionMemberProfile[];
}
export interface PeopleRequestOptions { signal?: AbortSignal }
export interface PeopleDirectoryOptions extends PeopleRequestOptions { members?: "require" | "if-approved" | "omit" }
/** Pinned metadata authority, separate from the native record-read capability. */
/** The records client people reads go through (an `MdbaseClient`). */
export interface PeopleRecords {
  queryContract: MdbaseClient["queryContract"];
  readyForRead(signal?: AbortSignal): Promise<Session>;
  currentSession(): Session;
}
export interface PeopleAuthority {
  /** Immutable collection UUID pinned by this metadata authority. */
  readonly collection: string;
  request(resource: "identity" | "members", options?: PeopleRequestOptions): Promise<unknown>;
  isCurrent(): boolean;
}
const responseError = () => mdbaseError("unavailable", "invalid people response", "people_response");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw responseError();
  return value as Record<string, unknown>;
}
function httpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
function profile(value: unknown): AccountProfile {
  const row = object(value);
  if (!httpUrl(row.issuer) || typeof row.subject !== "string" || !row.subject.trim() || typeof row.name !== "string" || !row.name.trim()) throw responseError();
  const accountId = row.account_id;
  if (accountId !== undefined) {
    if (typeof accountId !== "string") throw responseError();
    try { if (uuidToBytes(accountId).every(b => b === 0)) throw responseError(); } catch { throw responseError(); }
  }
  return { issuer: row.issuer, subject: row.subject, name: row.name, ...(accountId === undefined ? {} : { accountId: accountId as string }) };
}
export function sameIdentity(a: AccountIdentity, b: AccountIdentity): boolean { return a.issuer === b.issuer && a.subject === b.subject; }
function identities(value: unknown): AccountIdentity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!(entry instanceof Map)) return [];
    const issuer: unknown = entry.get("issuer"), subject: unknown = entry.get("subject");
    if (typeof issuer !== "string" || typeof subject !== "string") return [];
    return [{ issuer, subject }];
  });
}
type Inspection = { claims: AccountIdentity[] } & ({ reason: string } | { name: string; identities: AccountIdentity[] });
function inspect(projection: ContractProjection): Inspection {
  const data = projection.fields;
  if (!(data instanceof Map)) throw responseError();
  const name = data.get("name"), canonicalIdentities = data.get("identities");
  const claims = identities(canonicalIdentities);
  const error = projection.issues.find(issue => issue.severity === "error");
  if (error) return { reason: error.message, claims };
  if (typeof name !== "string" || !name.trim()) return { reason: "It needs a non-blank name.", claims };
  if (canonicalIdentities !== undefined && (!Array.isArray(canonicalIdentities) || claims.length !== canonicalIdentities.length || claims.some(claim => !claim.subject.trim())))
    return { reason: "Each account identity needs an exact issuer and subject.", claims };
  return { name, identities: claims, claims };
}

/** Complete directories only; cursor/scope failures never become partial success. */
export class MdbasePeopleClient {
  constructor(private readonly client: PeopleRecords, private readonly authority: PeopleAuthority) {}
  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!this.authority.isCurrent()) throw mdbaseError("unauthenticated", "people scope changed", "people_fenced");
  }
  private checkReadSession(session: Session): void {
    if (session !== this.client.currentSession() || session.closed) throw mdbaseError("unavailable", "people read session changed", "people_fenced");
    const expected = uuidToBytes(this.authority.collection), actual = uuidToBytes(session.hello.collection);
    if (expected.every(value => value === 0) || !expected.every((value, i) => value === actual[i]))
      throw mdbaseError("unauthenticated", "people collection binding changed", "people_binding");
  }
  async current(options: PeopleRequestOptions = {}): Promise<CurrentAccount> {
    this.check(options.signal);
    const body = await this.authority.request("identity", options); this.check(options.signal);
    const account = profile(body), settings = object(body).person_settings_url;
    if (settings === undefined) return account;
    if (!httpUrl(settings)) throw responseError();
    return { ...account, personSettingsUrl: settings };
  }
  async members(options: PeopleRequestOptions = {}): Promise<CollectionMemberProfile[]> {
    this.check(options.signal);
    const body = object(await this.authority.request("members", options)); this.check(options.signal);
    if (!Array.isArray(body.members) || body.members.length > 1000) throw responseError();
    return body.members.map(value => {
      const account = profile(value), role = object(value).role;
      if (role !== "owner" && role !== "editor" && role !== "viewer") throw responseError();
      return { ...account, role };
    });
  }
  async directory(options: PeopleDirectoryOptions = {}): Promise<PeopleDirectory> {
    const { members: mode = "if-approved", ...request } = options;
    if (!["require", "if-approved", "omit"].includes(mode)) throw mdbaseError("invalid_request", "invalid members mode");
    this.check(request.signal);
    // Metadata shares ONE original control slot. Sequence its two READs inside
    // this existing engine, never queue in the proxy or introduce another cache.
    // Native projections still run on the SAME client's independent data lane.
    const metadata = async () => {
      const account = await this.current(request); this.check(request.signal);
      const members = mode === "omit" ? undefined : await this.members(request).catch(error => {
        if (mode === "if-approved" && isMdbaseError(error, "forbidden") && error.reason === "people_permission_declined") return undefined;
        throw error;
      });
      this.check(request.signal); return {account, members};
    };
    const [{account, members}, records] = await Promise.all([metadata(), this.records(request)]);
    this.check(request.signal);
    this.checkReadSession(records.session);
    const invalid = records.invalid.filter(row => row.claims.some(claim => sameIdentity(claim, account)));
    const matches = records.people.filter(row => row.identities.some(claim => sameIdentity(claim, account)));
    const match = matches[0];
    const me: PersonResolution = invalid.length ? { status: "invalid", paths: invalid.map(row => row.path) }
      : matches.length > 1 ? { status: "ambiguous", paths: matches.map(row => row.path) }
      : match ? { status: "linked", person: match } : { status: "unlinked" };
    return { account, me, people: records.people, invalid: records.invalid.map(({ claims: _, ...row }) => row), ...(members === undefined ? {} : { members }) };
  }
  private async records(options: PeopleRequestOptions) {
    const session = await this.client.readyForRead(options.signal);
    this.check(options.signal); this.checkReadSession(session);
    let cursor: string | undefined, asOf: number | undefined, digest: string | undefined;
    const seen = new Set<string>(), cursors = new Set<string>();
    const people: PersonRecord[] = [], invalid: Array<InvalidPersonRecord & { claims: AccountIdentity[] }> = [];
    for (;;) {
      this.check(options.signal);
      const result = await this.client.queryContract(PERSON_CONTRACT, { pageSize: 128, ...(cursor ? { cursor } : {}), ...(options.signal ? { signal: options.signal } : {}) }).catch(error => {
        // A fresh collection may have no registered Person2.0 contract. Never
        // interpret disappearance after a page as a complete empty directory.
        if (!cursor && !seen.size && isMdbaseError(error, "not_found") && error.reason === "data_contract_not_found") return null;
        throw error;
      });
      this.check(options.signal);
      this.checkReadSession(session);
      if (!result) return { people, invalid, session };
      const { page } = result;
      if (!page.complete) throw mdbaseError("unavailable", "person inventory is incomplete", "people_incomplete");
      if ((asOf !== undefined && asOf !== page.asOf) || (digest !== undefined && digest !== result.contractDigest)) throw responseError();
      asOf = page.asOf; digest = result.contractDigest;
      for (const [i, row] of result.records.entries()) {
        const record = page.records[i];
        if (row.id !== record?.id || seen.has(row.id) || !row.implementations.length) throw responseError();
        seen.add(row.id);
        if (seen.size > 10000) throw mdbaseError("too_large", "person directory exceeds its record budget", "people_budget");
        const projections = row.implementations.map(inspect), first = projections[0]!;
        const reason = projections.find(value => "reason" in value);
        const claims = projections.flatMap(value => value.claims);
        if (reason && "reason" in reason) invalid.push({ id: row.id, path: record.path, reason: reason.reason, claims });
        else if (projections.some(value => JSON.stringify(value) !== JSON.stringify(first))) invalid.push({ id: row.id, path: record.path, reason: "Its Person implementations project different values.", claims });
        else if ("name" in first) people.push({ id: row.id, path: record.path, name: first.name, identities: first.identities, typeNames: [...new Set(row.implementations.map(value => value.typeName))].sort() });
      }
      if (!page.cursor) {
        if (page.hasMore === true || (page.totalCount !== undefined && page.totalCount !== seen.size)) throw mdbaseError("unavailable", "person inventory is incomplete", "people_incomplete");
        break;
      }
      if (cursors.has(page.cursor)) throw responseError();
      cursors.add(page.cursor); cursor = page.cursor;
    }
    const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    return { people: people.sort(byPath), invalid: invalid.sort(byPath), session };
  }
}
