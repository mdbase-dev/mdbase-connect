import React from "react";
import { describeActivity } from "./daemon-view.mjs";
import { Empty, SectionHeading } from "./ui-components";
import { relativeTime } from "./view-model";

export function ActivityView({ entries }: { entries: ActivityEntry[] | null }) {
  return (
    <section>
      <SectionHeading title="Recent activity" note="Kept on this computer only: the last 200 changes." />
      {entries === null ? <Empty title="Activity is unavailable" text="mdbase could not read this computer's activity. It is retried automatically." />
        : entries.length === 0 ? <Empty title="No activity yet" text="App access and collection changes on this computer will be listed here." />
          : <ol className="activity-list">{entries.map((entry, index) => (
            <li key={`${entry.at_ms}-${index}`}>
              <span>{describeActivity(entry)}</span>
              <time dateTime={new Date(entry.at_ms).toISOString()}>{relativeTime(new Date(entry.at_ms).toISOString())}</time>
            </li>
          ))}</ol>}
    </section>
  );
}
