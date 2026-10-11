/** Bounded metadata projection for the ORIGINAL collection control channel.
 * No credential, host, directory cache or second data client crosses this seam. */
import type { MdbaseClient } from "../client.js";
import { mdbaseError, MdbaseError, type ErrorCode } from "../errors.js";
import { MdbasePeopleClient } from "../people.js";
import type { AppCollectionControlClient } from "./collection-control.js";

export type CollectionPeopleResource = "identity" | "members";
type Profile = {issuer: string; subject: string; name: string; account_id?: string};
export type CollectionPeopleDto = (Profile & {person_settings_url?: string}) | {members: Array<Profile & {role: "owner" | "editor" | "viewer"}>};
export interface CollectionPeopleErrorDto {code: ErrorCode; reason: string}
const response = () => mdbaseError("unavailable", "invalid people response", "people_response");
const utf8 = new TextEncoder();
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw response();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw response();
  // Inspect descriptors, never evaluate getters (including discarded extras).
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw response();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw response();
    if (descriptor.enumerable) result[key] = descriptor.value;
  }
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || utf8.encode(value).byteLength > 4096) throw response();
  return value;
}
function url(value: unknown): string {
  const original = text(value);
  const parsed = new URL(original);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw response();
  return original;
}
function profile(value: unknown): Profile {
  const row = object(value);
  const result: Profile = {issuer: url(row.issuer), subject: text(row.subject), name: text(row.name)};
  if (row.account_id !== undefined) {
    if (typeof row.account_id !== "string" || !uuid.test(row.account_id) || row.account_id === "00000000-0000-0000-0000-000000000000") throw response();
    result.account_id = row.account_id;
  }
  return result;
}
function memberRows(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 1000) throw response();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) throw response();
  }
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) throw response();
    result.push(descriptor.value);
  }
  return result;
}
/** Allowlisted CP-shaped DTO; validation does not normalize provider identity. */
export function collectionPeopleDto(resource: CollectionPeopleResource, value: unknown): CollectionPeopleDto {
  try {
    const row = object(value);
    if (resource === "identity") {
      const result: Profile & {person_settings_url?: string} = profile(row);
      if (row.person_settings_url !== undefined) result.person_settings_url = url(row.person_settings_url);
      return result;
    }
    if (resource !== "members") throw response();
    const members = memberRows(row.members).map<Profile & {role: "owner" | "editor" | "viewer"}>(value => {
      const member = object(value), result = profile(member), role = member.role;
      if (role !== "owner" && role !== "editor" && role !== "viewer") throw response();
      return {...result, role};
    });
    return {members};
  } catch { throw response(); }
}
/** Only stable typed classes/codes, never messages/details/stack/cause. */
export function collectionPeopleError(resource: CollectionPeopleResource, error: unknown): CollectionPeopleErrorDto {
  try {
    if (error instanceof MdbaseError) {
      switch (error.code) {
        case "forbidden": return {code: "forbidden", reason: resource === "members" && error.reason === "people_permission_declined" ? "people_permission_declined" : "people_access"};
        case "unauthenticated": case "cancelled": return {code: "unauthenticated", reason: "people_fenced"};
        case "upgrade_required": return {code: "upgrade_required", reason: "people_unsupported"};
      }
    }
  } catch { /* Hostile diagnostic properties cannot escape the allowlist. */ }
  return {code: "unavailable", reason: "people_response"};
}
export function decodeCollectionPeopleError(value: unknown): MdbaseError {
  const row = object(value);
  const valid = (row.code === "forbidden" && ["people_permission_declined", "people_access"].includes(row.reason as string)) ||
    (row.code === "unauthenticated" && row.reason === "people_fenced") ||
    (row.code === "upgrade_required" && row.reason === "people_unsupported") ||
    (row.code === "unavailable" && ["people_response", "people_busy"].includes(row.reason as string));
  if (!valid || Object.keys(row).length !== 2) throw response();
  return mdbaseError(row.code as ErrorCode, "people metadata request failed", row.reason as string);
}
/** Borrow SAME public UI client/control; lifecycle remains their original owner. */
export function createAppCollectionPeople(client: MdbaseClient, control: AppCollectionControlClient): MdbasePeopleClient {
  if (!control.peopleAuthority) throw mdbaseError("upgrade_required", "people metadata is unsupported", "people_unsupported");
  return new MdbasePeopleClient(client, control.peopleAuthority);
}
