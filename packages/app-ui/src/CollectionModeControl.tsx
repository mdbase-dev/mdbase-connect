import { useEffect, useRef, useState } from "react";
import { t } from "@lingui/core/macro";
import { i18n, useLocaleRevision } from "./i18n.js";

type Mode = "private" | "cloud_copy";
type Status = { current_mode: Mode; execution_available: true; change: null | { target_mode: Mode; phase: string; retry_at?: string } };
function read(value: unknown): Status | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.execution_available !== true || (v.current_mode !== "private" && v.current_mode !== "cloud_copy")) return null;
  if (v.change !== null) {
    if (!v.change || typeof v.change !== "object") return null;
    const c = v.change as Record<string, unknown>;
    if ((c.target_mode !== "private" && c.target_mode !== "cloud_copy") || typeof c.phase !== "string") return null;
  }
  return v as Status;
}

/** Owner controls only. Visibility follows actual executor registration, not a
 * mode flag. Browser intent cannot produce native key/source consent. */
export function CollectionModeControl({ collectionId, load, change, native = false }: {
  collectionId: string;
  load(): Promise<unknown>;
  change(target: Mode, requestId: string): Promise<unknown>;
  native?: boolean;
}) {
  useLocaleRevision();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [step, setStep] = useState<Record<string, unknown> | null>(null);
  const intent = useRef<{target: Mode; id: string} | null>(null);
  const generation = useRef(0);
  // Callback identity changes with parent renders; it must not restart I/O.
  const callbacks = useRef({load, change}); callbacks.current = {load, change};
  useEffect(() => {
    const active = ++generation.current;
    setStatus(null); setStep(null); setFailure(false); setBusy(false); intent.current = null;
    void callbacks.current.load().then(value => {
      if (generation.current === active) setStatus(read(value));
    }).catch(() => { /* Older servers/non-owners expose no controls. */ });
    return () => { ++generation.current; };
  }, [collectionId]);
  async function refresh() {
    const active = generation.current;
    setBusy(true); setFailure(false);
    try {
      const next = read(await callbacks.current.load());
      if (active !== generation.current) return;
      setStatus(next);
      if (next && !next.change) { setStep(null); intent.current = null; }
    } catch { if (active === generation.current) setFailure(true); }
    finally { if (active === generation.current) setBusy(false); }
  }
  async function commit(target: Mode) {
    const active = generation.current;
    if (intent.current?.target !== target) intent.current = {target, id:crypto.randomUUID()};
    setBusy(true); setFailure(false);
    try {
      const result = await callbacks.current.change(target, intent.current.id);
      if (active !== generation.current) return;
      const next = read(await callbacks.current.load());
      if (active !== generation.current) return;
      setStatus(next);
      setStep(result && typeof result === "object" ? result as Record<string, unknown> : null);
    } catch { if (active === generation.current) setFailure(true); }
    finally { if (active === generation.current) setBusy(false); }
  }
  if (!status) return null;
  const pending = status.change;
  const target = pending?.target_mode ?? (status.current_mode === "private" ? "cloud_copy" : "private");
  const blocked = step?.phase === "waiting_for_devices" && Array.isArray(step.devices) ? step.devices.filter((v): v is string => typeof v === "string") : [];
  const retryAt = typeof step?.retry_at === "string" ? step.retry_at : typeof pending?.retry_at === "string" ? pending.retry_at : undefined;
  return <section className="mdbase-collection-mode" aria-label={t(i18n)({ message: "Collection storage mode", context: "Collection storage mode" })} aria-busy={busy}>
    <h3>{t(i18n)({ message: "Storage mode", context: "Collection storage mode" })}</h3>
    <p>{status.current_mode === "private" ? t(i18n)({ message: "Private", context: "Collection storage mode" }) : t(i18n)({ message: "Cloud copy", context: "Collection storage mode" })}</p>
    <p>{target === "private"
      ? t(i18n)({ message: "Only your devices can read new content after the switch finishes. mdbase may still be able to read older content.", context: "Collection storage mode" })
      : t(i18n)({ message: "mdbase will be able to read the collection, including its existing history, and serve it while your devices are off.", context: "Collection storage mode" })}</p>
    {pending && <p role="status">{blocked.length > 0 ? t(i18n)({ message: "Waiting for devices to update.", context: "Collection storage mode" }) : pending.phase === "waiting_for_token_expiry"
      ? t(i18n)({ message: "Waiting for older device connections to expire. Cloud copy remains on until the switch finishes.", context: "Collection storage mode" })
      : pending.phase === "waiting_for_device" ? t(i18n)({ message: "Open mdbase connect on one of the owner's devices to finish the switch.", context: "Collection storage mode" })
      : t(i18n)({ message: "Finishing the switch. Keep the owner device connected.", context: "Collection storage mode" })}</p>}
    {retryAt && Number.isFinite(Date.parse(retryAt)) && <p><time dateTime={retryAt}>{t(i18n)({ message: `Continue after ${new Date(retryAt).toLocaleString()}.`, context: "Collection storage mode" })}</time></p>}
    {blocked.length > 0 && <div role="status"><p>{t(i18n)({ message: "Update or revoke these devices before continuing:", context: "Collection storage mode" })}</p><ul>{blocked.map(id => <li key={id}><code>{id}</code></li>)}</ul></div>}
    {failure && <p role="alert">{t(i18n)({ message: "We couldn’t confirm progress. Refresh, then retry. An interrupted switch may already have started.", context: "Collection storage mode" })}</p>}
    <div>
      {(!pending || native) && <button type="button" className="mdbase-button" disabled={busy} onClick={() => void commit(target)}>{busy ? t(i18n)({ message: "Working…", context: "Collection storage mode" }) : pending ? t(i18n)({ message: "Continue on this device", context: "Collection storage mode" }) : target === "private" ? t(i18n)({ message: "Make private", context: "Collection storage mode" }) : t(i18n)({ message: "Turn on Cloud copy", context: "Collection storage mode" })}</button>}
      <button type="button" className="mdbase-button is-tertiary" disabled={busy} onClick={() => void refresh()}>{t(i18n)({ message: "Refresh status", context: "Collection storage mode" })}</button>
    </div>
  </section>;
}
