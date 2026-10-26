import { t, plural } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
export function countLabel(value: number, kind: "record" | "file" | "collection" | "hosted-collection" | "installation" | "folder" | "application-installation" | "computer") {
  switch (kind) {
    case "computer": return t(i18n)`${plural(value, { one: "# connected computer", other: "# connected computers" })}`;
    case "record": return t(i18n)`${plural(value, { one: "# record", other: "# records" })}`;
    case "file": return t(i18n)`${plural(value, { one: "# file", other: "# files" })}`;
    case "collection": return t(i18n)`${plural(value, { one: "# collection", other: "# collections" })}`;
    case "hosted-collection": return t(i18n)`${plural(value, { one: "# hosted collection", other: "# hosted collections" })}`;
    case "installation": return t(i18n)`${plural(value, { one: "# installation", other: "# installations" })}`;
    case "folder": return t(i18n)`${plural(value, { one: "# synced folder", other: "# synced folders" })}`;
    case "application-installation": return t(i18n)`${plural(value, { one: "# application installation", other: "# application installations" })}`;
  }
}
