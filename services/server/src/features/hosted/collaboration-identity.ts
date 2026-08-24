import { createHash } from "node:crypto";

import type { AwarenessColorName } from "@mdbase-dev/connect-protocol";
import {
  isValidAwarenessDisplayName,
  MAX_AWARENESS_NAME_BYTES,
  MAX_AWARENESS_NAME_SCALARS
} from "@mdbase-dev/connect-protocol";

/**
 * Server-authoritative presentation identity for collaboration awareness.
 *
 * The name comes from the authenticated control-plane user (never the email,
 * never client input) and the color is derived deterministically from a
 * domain-separated SHA-256 over the collection and user UUIDs, so a person
 * sees the same color in every room. If a stored user name cannot satisfy
 * the strict wire rules, this helper degrades to a generic bounded identity
 * instead of accepting anything client-shaped or failing the grant.
 */

export interface CollaborationPresentationIdentity {
  name: string;
  color: AwarenessColorName;
}

const AWARENESS_COLOR_DOMAIN = "mdbase:collaboration-awareness-color:v1";

const AWARENESS_COLORS: readonly AwarenessColorName[] = [
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "violet",
  "slate"
];

/** Generic bounded fallback for legacy rows or unsafe stored names. */
export const GENERIC_AWARENESS_IDENTITY: CollaborationPresentationIdentity = Object.freeze({
  name: "Participant",
  color: "slate"
});

/**
 * Deterministically map (collection, user) onto the fixed awareness palette.
 */
export function deriveAwarenessColor(
  collectionId: string,
  userId: string
): AwarenessColorName {
  const hash = createHash("sha256");
  hash.update(AWARENESS_COLOR_DOMAIN);
  hash.update(new Uint8Array(1));
  hash.update(Buffer.from(collectionId.replace(/-/g, ""), "hex"));
  hash.update(Buffer.from(userId.replace(/-/g, ""), "hex"));
  return AWARENESS_COLORS[hash.digest()[0] % AWARENESS_COLORS.length];
}

/**
 * Normalize a stored user display name into a safe awareness name: NFC,
 * trimmed, bounded to the shared scalar/byte budgets, free of control and
 * bidirectional-override characters.
 */
export function sanitizeAwarenessDisplayName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const normalized = name.normalize("NFC").trim();
  if (!isValidAwarenessDisplayName(normalized)) return null;
  if ([...normalized].length > MAX_AWARENESS_NAME_SCALARS) return null;
  if (Buffer.byteLength(normalized, "utf8") > MAX_AWARENESS_NAME_BYTES) return null;
  return normalized;
}

/**
 * Build the presentation identity plumbed to RegisterReplica /
 * UpdateApplicationReplica for replicas that carry a collaboration
 * capability.
 */
export function collaborationPresentationIdentity(
  user: { id: string; name: string | null | undefined },
  collectionId: string
): CollaborationPresentationIdentity {
  const name = sanitizeAwarenessDisplayName(user.name);
  if (name === null) {
    // Documented fallback: never accept a client-controlled name, and never
    // derive one from the email address.
    return { ...GENERIC_AWARENESS_IDENTITY };
  }
  return { name, color: deriveAwarenessColor(collectionId, user.id) };
}

interface UserLookup {
  query: <R extends { [column: string]: any }>(
    sql: string,
    params: unknown[]
  ) => Promise<{ rows: R[] }>;
}

/**
 * Resolve the awareness identity for an approved grant straight from the
 * authenticated control-plane user. Returns undefined when the grant carries
 * no collaboration capability; throws when the user row cannot be resolved.
 */
export async function resolveGrantAwarenessIdentity(
  connection: UserLookup,
  userId: string,
  collectionId: string,
  collaborationRequested: boolean
): Promise<CollaborationPresentationIdentity | undefined> {
  if (!collaborationRequested) return undefined;
  const owner = await connection.query<{ name: string | null }>(
    "SELECT name FROM users WHERE id = $1",
    [userId]
  );
  if (!owner.rows[0]) {
    throw new Error(
      "The authorizing user could not be resolved for collaboration access."
    );
  }
  return collaborationPresentationIdentity(
    { id: userId, name: owner.rows[0].name },
    collectionId
  );
}
