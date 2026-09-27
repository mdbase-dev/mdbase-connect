export const PEOPLE_PERMISSIONS = ["identity", "members"] as const;
export type PeoplePermission = (typeof PEOPLE_PERMISSIONS)[number];

/**
 * Control-plane consent declared in the exact application manifest. Required
 * permissions gate approval; the approving user chooses optional ones, and the
 * grant records the result.
 */
export interface ApplicationPeopleRequirement {
  version: 1;
  required?: PeoplePermission[];
  optional?: PeoplePermission[];
}

/**
 * Validates an approval choice against a declaration. An omitted choice
 * approves every declared permission, matching file-action approval.
 */
export function approvedPeoplePermissions(
  requirement: ApplicationPeopleRequirement | undefined,
  selected?: readonly string[]
): PeoplePermission[] {
  if (!requirement) {
    if (selected?.length) throw new Error("People permissions require an application people declaration.");
    return [];
  }
  const required = requirement.required ?? [];
  const optional = requirement.optional ?? [];
  const declared = new Set<string>([...required, ...optional]);
  if (
    requirement.version !== 1
    || declared.size === 0
    || declared.size !== required.length + optional.length
    || [...declared].some((permission) => !(PEOPLE_PERMISSIONS as readonly string[]).includes(permission))
  ) {
    throw new Error("People requirements need unique, disjoint, known required and optional permissions.");
  }
  const chosen = new Set(selected ?? declared);
  if (required.some((permission) => !chosen.has(permission)) || [...chosen].some((permission) => !declared.has(permission))) {
    throw new Error("Required people permissions must be approved and optional people permissions must be declared.");
  }
  return PEOPLE_PERMISSIONS.filter((permission) => chosen.has(permission));
}

/** Portable account identity, not a credential or collection permission. */
export interface AccountIdentity {
  issuer: string;
  subject: string;
}

export interface AccountProfile extends AccountIdentity {
  name: string;
}

/** Wire response for the current account. */
export interface CurrentAccountResponse extends AccountProfile {
  /** Where this account manages its person record; a route, never an identity. */
  person_settings_url?: string;
}

export interface CollectionMemberProfile extends AccountProfile {
  role: "owner" | "editor" | "viewer";
}
