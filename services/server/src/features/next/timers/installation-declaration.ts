import { capabilityOperations, capabilityOperationsForContractVersion, MDBASE_TIMER_FIRED_CONTRACT,
  type ApplicationNotifications } from "@mdbase-dev/connect-protocol";
import type { RegisteredApplication } from "../../applications/store.js";
import { canonicalJson, canonicalSha256 } from "../../../canonical-json.js";
import { installationEnvironment, type InstallationEnvironment } from "../../../local-deployment.js";

/** Public manifest metadata, NOT consent, a credential or a usable timer grant. */
export interface InstallationTimerDeclaration {
  schema: "mdbase-installation-timers/1";
  application_id: string;
  environment: InstallationEnvironment;
  app_origin: string;
  kind: "app-runtime" | "mobile";
  operations: string[];
  notifications: ApplicationNotifications;
  digest: string;
}
export type InstallationTimerBinding = Pick<InstallationTimerDeclaration, "environment" | "app_origin" | "kind">;
const operations = capabilityOperations("background.schedule");
const invalid = () => new Error("Invalid registered installation timer declaration.");
const digest = (value: Omit<InstallationTimerDeclaration, "digest">) =>
  canonicalSha256({ domain: "mdbase-installation-timers/1", declaration: value }).slice("sha256:".length);

/** The registry has already passed the shared manifest validator. Expand only
 * its declared capabilities; criteria alone and owner/device rights grant none. */
export function installationTimerDeclaration(
  application: Pick<RegisteredApplication, "id" | "requirements" | "notifications">,
  binding: InstallationTimerBinding,
  serverEnvironment?: string,
): InstallationTimerDeclaration | null {
  if (!installationEnvironment(binding.environment, binding.app_origin, serverEnvironment)) throw invalid();
  const capabilities = application.requirements.capabilities;
  if (!capabilities) return null;
  if (![1, 2].includes(capabilities.contract_version) || !Array.isArray(capabilities.required)
    || (capabilities.optional !== undefined && !Array.isArray(capabilities.optional))) throw invalid();
  const allowed = new Set<string>();
  for (const capability of [...capabilities.required, ...(capabilities.optional ?? [])]) {
    const expanded = capabilityOperationsForContractVersion(capabilities.contract_version, capability);
    if (!expanded) throw invalid();
    for (const operation of expanded) allowed.add(operation);
  }
  const selected = operations.filter(operation => allowed.has(operation));
  if (!selected.length) return null;
  if (!Array.isArray(application.notifications.criteria)) throw invalid();
  const criteria = application.notifications.criteria.filter(criterion =>
    criterion.event.id === MDBASE_TIMER_FIRED_CONTRACT.id
    && criterion.event.version === MDBASE_TIMER_FIRED_CONTRACT.version
    && criterion.event.digest === MDBASE_TIMER_FIRED_CONTRACT.digest);
  if (!criteria.length) return null;
  if (criteria.length > 100 || new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) throw invalid();
  const notifications: ApplicationNotifications = { criteria: structuredClone(criteria) };
  if (application.notifications.native_delivery) notifications.native_delivery = structuredClone(application.notifications.native_delivery);
  const value: Omit<InstallationTimerDeclaration, "digest"> = {
    schema: "mdbase-installation-timers/1", application_id: application.id, ...binding,
    operations: selected, notifications,
  };
  if (Buffer.byteLength(canonicalJson(value), "utf8") > 128 * 1024) throw invalid();
  return { ...value, digest: digest(value) };
}

/** A stored snapshot must retain its exact original bytes/meaning. A digest is
 * integrity metadata, not authentication; authorization still needs approval,
 * the original installation and current exact collection/device policy. */
export function readInstallationTimerDeclaration(value: unknown, serverEnvironment?: string): InstallationTimerDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const candidate = value as InstallationTimerDeclaration;
  const { digest: hash, ...body } = candidate;
  if (Object.keys(body).sort().join(",") !== "app_origin,application_id,environment,kind,notifications,operations,schema"
    || body.schema !== "mdbase-installation-timers/1"
    || typeof body.application_id !== "string" || typeof body.app_origin !== "string"
    || !installationEnvironment(body.environment, body.app_origin, serverEnvironment)
    || !["app-runtime", "mobile"].includes(body.kind)
    || !Array.isArray(body.operations) || !body.operations.length
    || body.operations.some(operation => !operations.includes(operation as typeof operations[number]))
    || new Set(body.operations).size !== body.operations.length
    || !body.notifications || !Array.isArray(body.notifications.criteria)
    || !body.notifications.criteria.length || body.notifications.criteria.length > 100
    || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)
    || digest(body) !== hash || Buffer.byteLength(canonicalJson(candidate), "utf8") > 128 * 1024) throw invalid();
  return structuredClone(candidate);
}
