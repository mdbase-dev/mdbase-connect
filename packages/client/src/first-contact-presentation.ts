import type { FirstContactBinding } from "@mdbase-dev/connect-protocol";
import { applicationInstallationId } from "./application-identity.js";
import type { MdbaseAuthorizeOptions } from "./connection.js";
import type { GrantKeyRecord, GrantKeyStore } from "./crypto.js";
import { deriveFirstContactSas } from "./first-contact.js";
import { connectError } from "./errors.js";
import type { Application } from "./internal-types.js";

export async function presentFirstContact(
  value: unknown,
  application: Application,
  installation: GrantKeyRecord,
  options: MdbaseAuthorizeOptions,
  previousFingerprint: string
): Promise<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw connectError(
      "invalid_first_contact",
      "The authorization service returned an invalid first-contact challenge."
    );
  }
  const binding = value as FirstContactBinding;
  const installationId = await applicationInstallationId(installation);
  if (
    binding.application_id !== application.id
    || binding.application_installation_id !== installationId
    || binding.application_agreement_public_key !== installation.agreementPublicKey
    || binding.application_signing_public_key !== installation.signingPublicKey
  ) {
    throw connectError(
      "invalid_first_contact",
      "The first-contact challenge does not match this application installation."
    );
  }
  const fingerprint = JSON.stringify(binding);
  if (fingerprint === previousFingerprint) return previousFingerprint;
  if (!options.onFirstContact) {
    throw connectError(
      "first_contact_handler_required",
      "Local access requires the application to display a first-contact comparison code."
    );
  }
  let authenticationString: string;
  try {
    authenticationString = await deriveFirstContactSas(binding, "application", installation);
  } catch (cause) {
    throw connectError(
      "invalid_first_contact",
      "The authorization service returned an invalid first-contact challenge.",
      { cause }
    );
  }
  await options.onFirstContact({
    binding,
    authenticationString,
    applicationId: binding.application_id,
    connectorId: binding.connector_id
  });
  return fingerprint;
}

export async function applicationIdentity(
  keyStore: GrantKeyStore,
  serverUrl: string,
  application: Application
): Promise<GrantKeyRecord> {
  const handle = `application-installation:${serverUrl}:${application.id}`;
  const existing = await keyStore.get(handle);
  if (existing) return existing;
  try {
    return await keyStore.create(handle);
  } catch (error) {
    const raced = await keyStore.get(handle);
    if (raced) return raced;
    throw error;
  }
}
