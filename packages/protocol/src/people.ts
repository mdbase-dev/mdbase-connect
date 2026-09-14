/** Explicit, required control-plane consent, bound by the exact manifest digest. */
export interface ApplicationPeopleRequirement {
  version: 1;
  permissions: Array<"identity" | "members">;
}

/** Portable account identity, not a credential or collection permission. */
export interface AccountIdentity {
  issuer: string;
  subject: string;
}

export interface AccountProfile extends AccountIdentity {
  name: string;
}

export interface CollectionMemberProfile extends AccountProfile {
  role: "owner" | "editor" | "viewer";
}
