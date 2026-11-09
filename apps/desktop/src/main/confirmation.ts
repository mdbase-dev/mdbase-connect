import { t } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";

/**
 * The daemon's on-screen confirmations (`runtime/crates/daemon/src/confirm.rs`).
 *
 * On Linux the daemon starts this app as its dialog program:
 * `mdbase-connect --mdbase-confirm=<prompt>`. The process shows one dialog and
 * prints `MDBASE_ALLOW` only when the user clicks Allow. The daemon trusts the
 * answer because it spawned the process and reads that child's stdout; the
 * running app's window has no part in it.
 */

const SWITCH = "--mdbase-confirm=";

/** The only output that means yes. */
export const ALLOW_LINE = "MDBASE_ALLOW\n";

/** Matches the daemon's dialog timeout; closing the dialog means no. */
export const CONFIRM_TIMEOUT_MS = 120_000;

interface ConfirmationRequest {
  v: number;
  kind: string;
  /** English wording, shown for a kind or version this app does not know. */
  title: string;
  message: string;
  app?: string;
  collection?: string;
  capabilities?: string[];
  folders?: string[] | null;
  key?: string;
  private?: boolean;
}

interface ConfirmationText {
  title: string;
  message: string;
  detail: string;
  allow: string;
  deny: string;
}

/** The prompt argument, when the daemon started this process as its dialog. */
export function confirmationArgument(argv: readonly string[]): string | null {
  const argument = argv.find((value) => value.startsWith(SWITCH));
  return argument === undefined ? null : argument.slice(SWITCH.length);
}

export function parseConfirmation(argument: string): ConfirmationRequest {
  const value = JSON.parse(argument) as Partial<ConfirmationRequest> | null;
  if (!value || typeof value !== "object" || typeof value.v !== "number" || typeof value.kind !== "string" ||
      typeof value.title !== "string" || typeof value.message !== "string") {
    throw new Error("Invalid confirmation prompt.");
  }
  return value as ConfirmationRequest;
}

function capabilityLabel(capability: string): string {
  switch (capability) {
    case "collection.read": return t(i18n)({ message: "read records and files", context: "Confirmation dialog" });
    case "records.create": return t(i18n)({ message: "create records and files", context: "Confirmation dialog" });
    case "records.edit": return t(i18n)({ message: "edit records and files", context: "Confirmation dialog" });
    case "records.delete": return t(i18n)({ message: "delete records and files", context: "Confirmation dialog" });
    case "views.manage": return t(i18n)({ message: "manage saved views", context: "Confirmation dialog" });
    case "definitions.manage": return t(i18n)({ message: "manage types and collection setup", context: "Confirmation dialog" });
    case "background.schedule": return t(i18n)({ message: "run scheduled background tasks", context: "Confirmation dialog" });
    case "offline.replica": return t(i18n)({ message: "keep an offline copy", context: "Confirmation dialog" });
    default: return capability;
  }
}

function wording(request: ConfirmationRequest): Pick<ConfirmationText, "title" | "message" | "detail"> {
  const collection = request.collection ?? "";
  if (request.v === 1) {
    switch (request.kind) {
      case "approve_app": {
        const app = request.app ?? "";
        const access = (request.capabilities ?? []).map(capabilityLabel).join(", ");
        const folders = request.folders?.join(", ") ??
          t(i18n)({ message: "whole collection", context: "Confirmation dialog" });
        const key = request.key ?? "";
        return {
          title: t(i18n)({ message: "Approve app access", context: "Confirmation dialog" }),
          message: t(i18n)({ message: `Allow ${app} to use ${collection} through this computer?`, context: "Confirmation dialog" }),
          detail: [
            t(i18n)({ message: `Access: ${access}`, context: "Confirmation dialog" }),
            t(i18n)({ message: `Folders: ${folders}`, context: "Confirmation dialog" }),
            t(i18n)({ message: `App key: ${key}`, context: "Confirmation dialog" }),
            "",
            t(i18n)({ message: "Check that the app's access request in your browser shows the same key.", context: "Confirmation dialog" })
          ].join("\n")
        };
      }
      case "disable_approval":
        return {
          title: t(i18n)({ message: "Turn off approval", context: "Confirmation dialog" }),
          message: t(i18n)({ message: "Let new apps use your local collections without asking you first?", context: "Confirmation dialog" }),
          detail: t(i18n)({ message: "You will still be notified.", context: "Confirmation dialog" })
        };
      case "link_obsidian":
        return {
          title: t(i18n)({ message: "Link Obsidian", context: "Confirmation dialog" }),
          message: t(i18n)({ message: `Let Obsidian on this computer use ${collection}?`, context: "Confirmation dialog" }),
          detail: ""
        };
      case "collection_mode":
        return request.private
          ? {
            title: t(i18n)({ message: "Make private", context: "Confirmation dialog" }),
            message: t(i18n)({ message: `Make ${collection} private?`, context: "Confirmation dialog" }),
            detail: t(i18n)({ message: "Only your devices can read new content after the switch finishes. mdbase may still be able to read older content.", context: "Confirmation dialog" })
          }
          : {
            title: t(i18n)({ message: "Turn on Cloud copy", context: "Confirmation dialog" }),
            message: t(i18n)({ message: `Turn on Cloud copy for ${collection}?`, context: "Confirmation dialog" }),
            detail: t(i18n)({ message: "mdbase will be able to read the collection, including its existing history, and serve it while your devices are off.", context: "Confirmation dialog" })
          };
    }
  }
  return { title: request.title, message: request.message, detail: "" };
}

/** The dialog's text in the active locale. */
export function describeConfirmation(request: ConfirmationRequest): ConfirmationText {
  return {
    ...wording(request),
    allow: t(i18n)({ message: "Allow", context: "Confirmation dialog" }),
    deny: t(i18n)({ message: "Deny", context: "Confirmation dialog" })
  };
}
