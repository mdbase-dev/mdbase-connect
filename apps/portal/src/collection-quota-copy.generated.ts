import { t } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";

export function collectionQuotaMessage(): string {
  return t(i18n)({ message: "Your account has reached its synced collection limit. Open an existing collection, delete one you own if Delete is available, or contact mdbase support to raise your limit." });
}
