import type { ApplicationFileRequirement } from "./files.js";
import {
  isMutatingOperation,
  type CollectionOperation
} from "./operations.js";
import type {
  AuthorizationBindingProtocolVersion,
  ConnectContractRequirements
} from "./compatibility.js";
import {
  AUTHORIZATION_BINDING_PROTOCOL_VERSION,
  LEGACY_AUTHORIZATION_BINDING_PROTOCOL_VERSION,
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  isSupportedAuthorizationBinding,
  isSupportedOperationTransport
} from "./compatibility.js";

export type ApplicationAuthorizationFlow = "authorization_code" | "device_code";

export interface ApplicationAuthorizationBinding {
  protocol_version: AuthorizationBindingProtocolVersion;
  authorization_id: string;
  application_id: string;
  application_declaration_id: string;
  application_manifest_digest: string;
  application_installation_id: string;
  installation_signing_public_key: string;
  grant_agreement_public_key: string;
  grant_signing_public_key: string;
  flow: ApplicationAuthorizationFlow;
  authorization_nonce: string;
  issued_at: string;
  expires_at: string;
  redirect_uri?: string;
  state?: string;
  code_challenge: string;
  contracts: ConnectContractRequirements;
  requested_operations: CollectionOperation[];
  requested_files?: ApplicationFileRequirement;
  collection_id?: string;
}

export interface ApplicationAuthorizationProof {
  binding: ApplicationAuthorizationBinding;
  signature: string;
}

const INSTALLATION_ID_DOMAIN = new TextEncoder().encode(
  "mdbase-connect application installation id v2\0"
);
const AUTHORIZATION_PROOF_V4_DOMAIN = new TextEncoder().encode(
  "mdbase-connect application authorization proof v4\0"
);
const AUTHORIZATION_PROOF_V5_DOMAIN = new TextEncoder().encode(
  "mdbase-connect application authorization proof v5\0"
);

export async function applicationInstallationIdFromPublicKey(
  signingPublicKey: string
): Promise<string> {
  const signing = publicKey(signingPublicKey);
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    concat([INSTALLATION_ID_DOMAIN, field(signing)]) as BufferSource
  ));
  const id = digest.slice(0, 16);
  id[6] = (id[6]! & 0x0f) | 0x80;
  id[8] = (id[8]! & 0x3f) | 0x80;
  return [
    hex(id.slice(0, 4)),
    hex(id.slice(4, 6)),
    hex(id.slice(6, 8)),
    hex(id.slice(8, 10)),
    hex(id.slice(10, 16))
  ].join("-");
}

export function authorizationSigningMessage(
  binding: ApplicationAuthorizationBinding
): Uint8Array {
  const keys = [
    publicKey(binding.installation_signing_public_key),
    publicKey(binding.grant_agreement_public_key),
    publicKey(binding.grant_signing_public_key)
  ];
  if (keys.some((key, index) =>
    keys.slice(index + 1).some((other) => equalBytes(key, other)))) {
    throw new Error("Application authorization keys must be distinct.");
  }
  const nonce = canonicalBase64(binding.authorization_nonce);
  const challenge = canonicalBase64(binding.code_challenge);
  const contracts = binding.contracts;
  const recovery = contracts.operation_transport_recovery ?? [];
  const requiresDurableMutation = binding.requested_operations.some((operation) =>
    isMutatingOperation(operation, { action: "mutate" }))
    || binding.requested_files?.actions.some((action) =>
      !["list", "read"].includes(action)) === true;
  if (
    !isSupportedAuthorizationBinding(binding.protocol_version)
    || nonce.byteLength !== 32
    || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(binding.application_declaration_id)
    || !/^[0-9a-f]{64}$/u.test(binding.application_manifest_digest)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(binding.issued_at)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(binding.expires_at)
    || challenge.byteLength !== 32
    || ![
      contracts.operation_transport,
      contracts.authorization_binding,
      contracts.semantic_capabilities,
      contracts.durable_mutation ?? 1
    ].every((version) => Number.isInteger(version) && version > 0)
    || contracts.authorization_binding !== binding.protocol_version
    || !isSupportedOperationTransport(contracts.operation_transport)
    || (binding.protocol_version === AUTHORIZATION_BINDING_PROTOCOL_VERSION
      && contracts.operation_transport !== OPERATION_TRANSPORT_PROTOCOL_VERSION)
    || recovery.some((version) =>
      !isSupportedOperationTransport(version)
      || version === contracts.operation_transport)
    || new Set(recovery).size !== recovery.length
    || (binding.protocol_version === LEGACY_AUTHORIZATION_BINDING_PROTOCOL_VERSION
      && recovery.length > 0)
    || (recovery.length > 0 && !requiresDurableMutation)
    || (requiresDurableMutation
      ? contracts.durable_mutation !== 1
      : contracts.durable_mutation !== undefined)
    || (binding.requested_operations.length === 0 && binding.requested_files === undefined)
    || new Set(binding.requested_operations).size !== binding.requested_operations.length
    || binding.requested_operations.some((operation) => !operation || operation.includes("\0"))
    || (binding.flow === "authorization_code"
      ? binding.redirect_uri === undefined || binding.state === undefined
      : binding.flow === "device_code"
        ? binding.redirect_uri !== undefined || binding.state !== undefined
        : true)
  ) {
    throw new Error("Application authorization binding is invalid.");
  }
  validateRequestedFiles(binding.requested_files);
  const operationFields = binding.requested_operations.map((operation) =>
    field(new TextEncoder().encode(operation)));
  return concat([
    binding.protocol_version === AUTHORIZATION_BINDING_PROTOCOL_VERSION
      ? AUTHORIZATION_PROOF_V5_DOMAIN
      : AUTHORIZATION_PROOF_V4_DOMAIN,
    u32(binding.protocol_version),
    field(uuidBytes(binding.application_id)),
    field(uuidBytes(binding.authorization_id)),
    field(new TextEncoder().encode(binding.application_declaration_id)),
    field(hexBytes(binding.application_manifest_digest)),
    field(uuidBytes(binding.application_installation_id)),
    ...keys.map(field),
    field(new TextEncoder().encode(binding.flow)),
    field(nonce),
    field(new TextEncoder().encode(binding.issued_at)),
    field(new TextEncoder().encode(binding.expires_at)),
    optionalString(binding.redirect_uri),
    optionalString(binding.state),
    field(new TextEncoder().encode(binding.code_challenge)),
    u32(contracts.operation_transport),
    ...(binding.protocol_version === AUTHORIZATION_BINDING_PROTOCOL_VERSION
      ? [u32(recovery.length), ...recovery.map(u32)]
      : []),
    u32(contracts.authorization_binding),
    u32(contracts.semantic_capabilities),
    optionalU32(contracts.durable_mutation),
    u32(operationFields.length),
    ...operationFields,
    requestedFiles(binding.requested_files),
    optionalUuid(binding.collection_id)
  ]);
}

function optionalU32(value: number | undefined): Uint8Array {
  return value === undefined
    ? new Uint8Array(1)
    : concat([new Uint8Array([1]), u32(value)]);
}

function validateRequestedFiles(
  files: ApplicationAuthorizationBinding["requested_files"]
): void {
  if (files === undefined) return;
  if (
    files.actions.length === 0
    || new Set(files.actions).size !== files.actions.length
    || (files.scope.kind === "selected_folders"
      && (files.scope.folders.length === 0
        || new Set(files.scope.folders).size !== files.scope.folders.length
        || files.scope.folders.some((folder) => !folder || folder.includes("\0"))))
  ) {
    throw new Error("Application authorization file request is invalid.");
  }
}

function requestedFiles(
  files: ApplicationAuthorizationBinding["requested_files"]
): Uint8Array {
  if (files === undefined) return new Uint8Array(1);
  const actions = files.actions.map((action) => field(new TextEncoder().encode(action)));
  return concat([
    new Uint8Array([1]),
    u32(actions.length),
    ...actions,
    field(new TextEncoder().encode(files.scope.kind)),
    ...(files.scope.kind === "selected_folders"
      ? [
          u32(files.scope.folders.length),
          ...files.scope.folders.map((folder) => field(new TextEncoder().encode(folder)))
        ]
      : [])
  ]);
}

function optionalString(value: string | undefined): Uint8Array {
  return value === undefined
    ? new Uint8Array(1)
    : concat([new Uint8Array([1]), field(new TextEncoder().encode(value))]);
}

function optionalUuid(value: string | undefined): Uint8Array {
  return value === undefined
    ? new Uint8Array(1)
    : concat([new Uint8Array([1]), field(uuidBytes(value))]);
}

function publicKey(value: string): Uint8Array {
  const key = canonicalBase64(value);
  if (key.byteLength !== 65 || key[0] !== 4) {
    throw new Error("Application authorization public key is invalid.");
  }
  return key;
}

function canonicalBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value.");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (base64Url(decoded) !== value) throw new Error("Non-canonical base64url value.");
  return decoded;
}

function uuidBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("Invalid UUID value.");
  }
  const compact = value.replaceAll("-", "");
  return hexBytes(compact);
}

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal value.");
  }
  return Uint8Array.from(
    { length: value.length / 2 },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  );
}

function field(value: Uint8Array): Uint8Array {
  return concat([u32(value.byteLength), value]);
}

function u32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function concat(values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce(
    (length, value) => length + value.byteLength,
    0
  ));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
