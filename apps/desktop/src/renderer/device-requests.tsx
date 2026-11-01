import { select, t } from "@lingui/core/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React from "react";
import { ApprovalPrompt } from "./approval-prompt";
import { groupedApprovalCode } from "./daemon-view.mjs";
import { SectionHeading } from "./ui-components";

type Act = (action: () => Promise<unknown>) => Promise<void>;

/** Other computers of yours asking to open a Private collection this computer has. */
export function DeviceRequests({ devices, names, busy, onAct, onNotice }: {
  devices: PendingDevice[];
  names: Record<string, string>;
  busy: boolean;
  onAct: Act;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  if (devices.length === 0) return null;
  return (
    <section>
      <SectionHeading title={t(i18n)`Waiting for you`} note={t(i18n)`Allow only a computer you are setting up yourself.`} count={devices.length} />
      <div className="request-list">{devices.map((device) => (
        <DeviceRequest key={`${device.collection}/${device.device}`} device={device} collection={names[device.collection] ?? device.collection_name ?? t(i18n)`a Private collection`} busy={busy} onAct={onAct} onNotice={onNotice} />
      ))}</div>
    </section>
  );
}

function DeviceRequest({ device, collection, busy, onAct, onNotice }: {
  device: PendingDevice;
  collection: string;
  busy: boolean;
  onAct: Act;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  const who = device.name ?? select(device.kind, {
    desktop: "Another computer",
    mobile: "Another phone",
    other: "Another device",
  });
  return <ApprovalPrompt
    title={t(i18n)`${who} wants to open ${collection}`}
    check={<div aria-live="polite">
      {device.sas ? <>
        <span>{t(i18n)`Only allow if this matches the code on ${who}`}</span>
        <strong className="approval-code">{groupedApprovalCode(device.sas)}</strong>
      </> : <span>{t(i18n)`Preparing comparison code…`}</span>}
    </div>}
    approveDisabled={!device.sas}
    approveLabel={t(i18n)`Allow`}
    declineLabel={t(i18n)`Deny`}
    busy={busy}
    onDecline={() => void onAct(async () => {
      await window.mdbaseConnect.rejectDevice(device.collection, device.device);
      onNotice(t(i18n)`${who} was not given access to ${collection}.`);
    })}
    onApprove={() => void onAct(async () => {
      if (!device.sas) return;
      onNotice(t(i18n)`Allowing ${who}…`);
      await window.mdbaseConnect.approveDevice(device.collection, device.device, device.sas);
      onNotice(t(i18n)`${who} can now open ${collection}.`);
    })}
  />;
}
