export interface InvitationPageInput {
  limit?: number;
  cursor?: string;
  status?: "active" | "accepted" | "revoked" | "expired";
}

export interface InvitationRow {
  id: string;
  email: string;
  created_by: string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  send_count: number | string;
  last_sent_at: Date | string | null;
  entitlement_profile: string | null;
  created_at: Date | string;
}

export function invitationSummary(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    status: invitationStatus(row),
    created_by: row.created_by,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    accepted_at: nullableIso(row.accepted_at),
    revoked_at: nullableIso(row.revoked_at),
    revoked_by: row.revoked_by,
    revocation_reason: row.revocation_reason,
    send_count: Number(row.send_count),
    last_sent_at: nullableIso(row.last_sent_at),
    entitlement_profile: row.entitlement_profile
  };
}

export function invitationStatusCondition(
  status: NonNullable<InvitationPageInput["status"]>
): string {
  if (status === "accepted") return "accepted_at IS NOT NULL";
  if (status === "revoked") {
    return "accepted_at IS NULL AND revoked_at IS NOT NULL";
  }
  if (status === "expired") {
    return "accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()";
  }
  return "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()";
}

function invitationStatus(
  row: Pick<InvitationRow, "accepted_at" | "revoked_at" | "expires_at">
): "active" | "accepted" | "revoked" | "expired" {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}
