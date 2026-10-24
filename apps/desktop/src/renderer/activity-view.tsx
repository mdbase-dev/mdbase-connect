import { t } from "@lingui/core/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React from "react";
import { describeActivity } from "./daemon-view.mjs";
import { Empty, SectionHeading } from "./ui-components";
import { relativeTime } from "./view-model";

export function ActivityView({ entries }: { entries: ActivityEntry[] | null }) {
  useLocaleRevision();
  return (
    <section>
      <SectionHeading title={t(i18n)({ message: "Recent activity", context: "Connect interface" })} note={t(i18n)({ message: "Kept on this computer only: the last 200 changes." })} />
      {entries === null ? <Empty title={t(i18n)({ message: "Activity is unavailable", context: "Connect interface" })} text={t(i18n)({ message: "mdbase could not read this computer's activity. It is retried automatically." })} />
        : entries.length === 0 ? <Empty title={t(i18n)({ message: "No activity yet", context: "Connect interface" })} text={t(i18n)({ message: "App access and collection changes on this computer will be listed here." })} />
          : <ol className="activity-list">{entries.map((entry, index) => (
            <li key={`${entry.at_ms}-${index}`}>
              <span>{describeActivity(entry)}</span>
              <time dateTime={new Date(entry.at_ms).toISOString()}>{relativeTime(new Date(entry.at_ms).toISOString())}</time>
            </li>
          ))}</ol>}
    </section>
  );
}
