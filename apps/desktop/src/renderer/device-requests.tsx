import { select, t } from "@lingui/core/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useState } from "react";
import { ApprovalPrompt } from "./approval-prompt";
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
  const digits = code.replace(/\s/gu, "");
  const inputId = `device-code-${device.collection}-${device.device}`;
  return <ApprovalPrompt
    title={select(device.kind, {
      desktop: `A new computer wants to open ${name}`,
      mobile: `A new phone wants to open ${name}`,
      other: `A new device wants to open ${name}`,
    })}
    can={t(i18n)`If you approve, it can read and change everything in ${name}, as this computer can.`}
    check={<>
      <label htmlFor={inputId}>{select(device.kind, {
        desktop: "Enter the six-digit code shown on the new computer",
        mobile: "Enter the six-digit code shown on the new phone",
        other: "Enter the six-digit code shown on the new device",
      })}</label>
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
      {mismatch && <span role="alert">{select(device.kind, {
        desktop: "That code does not match. Check the code on the new computer. If you did not start this, decline.",
        mobile: "That code does not match. Check the code on the new phone. If you did not start this, decline.",
        other: "That code does not match. Check the code on the new device. If you did not start this, decline.",
      })}</span>}
    </>}
    approveLabel={t(i18n)({ message: "Approve", context: "Connect interface" })}
    approveDisabled={!/^\d{6}$/u.test(digits)}
    busy={busy}
    onDecline={() => void onAct(async () => {
      await window.mdbaseConnect.rejectDevice(device.collection, device.device);
      onNotice(select(device.kind, {
        desktop: `The new computer was not given access to ${name}.`,
        mobile: `The new phone was not given access to ${name}.`,
        other: `The new device was not given access to ${name}.`,
      }));
    })}
    onApprove={() => {
      // The new device's screen is the check: never approve on a code that differs.
      if (digits !== device.code) {
        setMismatch(true);
        return;
      }
      void onAct(async () => {
        await window.mdbaseConnect.approveDevice(device.collection, device.device, digits);
        onNotice(select(device.kind, {
          desktop: `The new computer can now open ${name}.`,
          mobile: `The new phone can now open ${name}.`,
          other: `The new device can now open ${name}.`,
        }));
      });
    }}
  />;
}
