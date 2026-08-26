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
 * The initial private experiment deliberately uses a generic name rather than
 * copying durable profile PII into provider storage. Color is derived from a
 * domain-separated SHA-256 over collection and authenticated user UUIDs. The
 * provider adds a process-local room ordinal when presenting generic names.
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
  userId: string,
  collectionId: string
): CollaborationPresentationIdentity {
  return {
    name: GENERIC_AWARENESS_IDENTITY.name,
    color: deriveAwarenessColor(collectionId, userId)
  };
}

/**
 * Resolve the awareness identity for an approved grant from the authenticated
 * control-plane user id. Returns undefined for ordinary grants.
 */
export function resolveGrantAwarenessIdentity(
  userId: string,
  collectionId: string,
  collaborationRequested: boolean
): CollaborationPresentationIdentity | undefined {
  if (!collaborationRequested) return undefined;
  return collaborationPresentationIdentity(userId, collectionId);
}
