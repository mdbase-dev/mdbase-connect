import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useState } from "react";
import { ApprovalPrompt } from "./approval-prompt";
import { deviceLabel } from "./daemon-view.mjs";
import { SectionHeading } from "./ui-components";

type Act = (action: () => Promise<unknown>) => Promise<void>;

/** New computers asking to open a Private collection that this computer can unlock. */
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
      <SectionHeading title={t(i18n)({ message: "New devices waiting", context: "Connect interface" })} note={t(i18n)({ message: "Approve a device only if you started setting it up yourself." })} count={devices.length} />
      <div className="request-list">{devices.map((device) => (
        <DeviceRequest key={`${device.collection}/${device.device}`} device={device} name={names[device.collection] ?? t(i18n)`a Private collection`} busy={busy} onAct={onAct} onNotice={onNotice} />
      ))}</div>
    </section>
  );
}

function DeviceRequest({ device, name, busy, onAct, onNotice }: {
  device: PendingDevice;
  name: string;
  busy: boolean;
  onAct: Act;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  const [code, setCode] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const label = deviceLabel(device.kind);
  const digits = code.replace(/\s/gu, "");
  const inputId = `device-code-${device.collection}-${device.device}`;
  return <ApprovalPrompt
    title={t(i18n)`A new ${label} wants to open ${name}`}
    can={t(i18n)`If you approve, it can read and change everything in ${name}, as this computer can.`}
    check={<>
      <label htmlFor={inputId}><Trans>Enter the six-digit code shown on the new {label}</Trans></label>
      <input
        id={inputId}
        className="device-code"
        inputMode="numeric"
        autoComplete="off"
        maxLength={7}
        value={code}
        aria-invalid={mismatch}
        onChange={(event) => { setCode(event.target.value); setMismatch(false); }}
      />
      {mismatch && <span role="alert"><Trans>That code does not match. Check the code on the new {label}. If you did not start this, decline.</Trans></span>}
    </>}
    approveLabel={t(i18n)({ message: "Approve", context: "Connect interface" })}
    approveDisabled={!/^\d{6}$/u.test(digits)}
    busy={busy}
    onDecline={() => void onAct(async () => {
      await window.mdbaseConnect.rejectDevice(device.collection, device.device);
      onNotice(t(i18n)`The new ${label} was not given access to ${name}.`);
    })}
    onApprove={() => {
      // The new device's screen is the check: never approve on a code that differs.
      if (digits !== device.code) {
        setMismatch(true);
        return;
      }
      void onAct(async () => {
        await window.mdbaseConnect.approveDevice(device.collection, device.device, digits);
        onNotice(t(i18n)`The new ${label} can now open ${name}.`);
      });
    }}
  />;
}
