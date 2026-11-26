import { useEffect, useRef, useState } from "react";
import { plural, t } from "@lingui/core/macro";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { i18n, useLocaleRevision } from "./i18n.js";

type Mode = "private" | "cloud_copy";
type ModeChange = {
  request_id?: string;
  source_mode?: Mode;
  target_mode: Mode;
  phase: string;
  retry_at?: string;
};
export type CollectionModeStatus = {
  current_mode: Mode;
  execution_available: true;
  change: null | ModeChange;
};

type ModeErrorKind =
  | "not_confirmed"
  | "keyed_owner_required"
  | "mode_abandoned"
  | "mode_switch_unavailable"
  | "mode_already_published"
  | "mode_rekey_observed"
  | "unknown";

type BlockedEntry = { requestId?: string; devices: string[]; names?: Record<string, string> };

const ACTIVE_POLL_MS = 3_000;
const WAITING_POLL_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const BLOCKED_STORAGE_PREFIX = "mdbase:mode-blocked:";

function read(value: unknown): CollectionModeStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.execution_available !== true || (v.current_mode !== "private" && v.current_mode !== "cloud_copy")) return null;
  if (v.change !== null) {
    if (!v.change || typeof v.change !== "object") return null;
    const c = v.change as Record<string, unknown>;
    if ((c.target_mode !== "private" && c.target_mode !== "cloud_copy") || typeof c.phase !== "string") return null;
    if (c.source_mode !== undefined && c.source_mode !== "private" && c.source_mode !== "cloud_copy") return null;
  }
  return v as CollectionModeStatus;
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; reason?: unknown; details?: unknown };
  if (e.details && typeof e.details === "object" && "code" in e.details && typeof (e.details as { code?: unknown }).code === "string") {
    return (e.details as { code: string }).code;
  }
  if (typeof e.reason === "string") return e.reason;
  if (typeof e.code === "string" && e.code !== "http_error") return e.code;
  return undefined;
}

function classifyModeError(error: unknown): ModeErrorKind {
  const code = errorCodeOf(error);
  if (code === "not_confirmed") return "not_confirmed";
  if (code === "keyed_owner_required") return "keyed_owner_required";
  if (code === "mode_abandoned") return "mode_abandoned";
  if (code === "mode_switch_unavailable") return "mode_switch_unavailable";
  if (code === "mode_already_published") return "mode_already_published";
  if (code === "mode_rekey_observed") return "mode_rekey_observed";
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/\bnot_confirmed\b|not confirmed on this computer/i.test(text)) return "not_confirmed";
  if (/\bkeyed_owner_required\b|owner device holding this collection['’]s trusted key/i.test(text)) return "keyed_owner_required";
  if (/\bmode_abandoned\b/i.test(text)) return "mode_abandoned";
  if (/\bmode_switch_unavailable\b|switching this collection isn['’]t available yet/i.test(text)) return "mode_switch_unavailable";
  if (/\bmode_already_published\b/i.test(text)) return "mode_already_published";
  if (/\bmode_rekey_observed\b/i.test(text)) return "mode_rekey_observed";
  return "unknown";
}

function readBlocked(collectionId: string): BlockedEntry | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(`${BLOCKED_STORAGE_PREFIX}${collectionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { requestId?: unknown; devices?: unknown; names?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.devices)) return null;
    const devices = parsed.devices.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (!devices.length) return null;
    const names = blockedNames(parsed.names, devices);
    return { ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}), devices, ...(names ? { names } : {}) };
  } catch {
    return null;
  }
}

/** Display names the daemon passed through from the server, limited to the blocked IDs. */
function blockedNames(value: unknown, devices: readonly string[]): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const names = Object.fromEntries(devices.flatMap((id) => {
    const name = (value as Record<string, unknown>)[id];
    return typeof name === "string" && name.trim() ? [[id, name.trim().slice(0, 80)]] : [];
  }));
  return Object.keys(names).length ? names : undefined;
}

function writeBlocked(collectionId: string, entry: BlockedEntry | null): void {
  try {
    const key = `${BLOCKED_STORAGE_PREFIX}${collectionId}`;
    if (!entry || !entry.devices.length) globalThis.sessionStorage?.removeItem(key);
    else globalThis.sessionStorage?.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage may be unavailable in restricted contexts; in-memory state still works.
  }
}

function blockedStillApplies(entry: BlockedEntry | null, status: CollectionModeStatus | null): boolean {
  if (!entry || !entry.devices.length || !status) return false;
  if (status.current_mode === "private" && !status.change) return false;
  if (!status.change) return entry.requestId === undefined;
  if (status.change.phase !== "waiting_for_device" && status.change.phase !== "waiting_for_devices") return false;
  if (entry.requestId && status.change.request_id && entry.requestId !== status.change.request_id) return false;
  return true;
}

function shortDeviceId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function activeLocale(): string {
  return i18n.locale === "pt" ? "pt-BR" : i18n.locale === "zh" ? "zh-CN" : i18n.locale;
}

function formatFinishTime(retryAt: string, nowMs: number): string | null {
  const targetMs = Date.parse(retryAt);
  if (!Number.isFinite(targetMs)) return null;
  const remainingMs = targetMs - nowMs;
  if (remainingMs <= 0) {
    return t(i18n)({ message: "Older app connections have expired. Finishing automatically…", context: "Collection storage mode" });
  }
  const date = new Date(targetMs);
  const locale = activeLocale();
  if (remainingMs < DAY_MS) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
    return t(i18n)({ message: `Expected to finish in about ${plural(minutes, { one: "# minute", other: "# minutes" })} (around ${time}).`, context: "Collection storage mode" });
  }
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
  return t(i18n)({ message: `Expected to finish around ${dateTime}.`, context: "Collection storage mode" });
}

function errorText(kind: Exclude<ModeErrorKind, "not_confirmed" | "mode_switch_unavailable">): string {
  switch (kind) {
    case "keyed_owner_required":
      return t(i18n)({ message: "Use a device that holds this collection’s key to switch its storage mode.", context: "Collection storage mode" });
    case "mode_abandoned":
      return t(i18n)({ message: "This collection can’t switch modes until the stopped switch to Private finishes recovering. Revoke the device that started it so your other owner devices replace the collection key.", context: "Collection storage mode" });
    case "mode_already_published":
      return t(i18n)({ message: "This switch has already started publishing and can no longer be cancelled.", context: "Collection storage mode" });
    case "mode_rekey_observed":
      return t(i18n)({ message: "Another device has already replaced the collection key. Refresh status to see the latest state.", context: "Collection storage mode" });
    case "unknown":
      return t(i18n)({ message: "We couldn’t confirm progress. Refresh, then retry. An interrupted switch may already have started.", context: "Collection storage mode" });
  }
}

/** Owner controls only. Visibility follows actual executor registration, not a
 * mode flag. Browser intent cannot produce native key/source consent. */
export function CollectionModeControl({
  collectionId,
  load,
  change,
  cancel,
  abandon,
  native = false,
  deviceNames,
  initialStatus,
  onModeChange,
  onStatusChange
}: {
  collectionId: string;
  load(): Promise<unknown>;
  change(target: Mode, requestId: string): Promise<unknown>;
  native?: boolean;
  cancel?(target: Mode, requestId: string): Promise<unknown>;
  abandon?(requestId: string): Promise<unknown>;
  deviceNames?: Readonly<Record<string, string>>;
  initialStatus?: unknown;
  onModeChange?(mode: Mode): void;
  onStatusChange?(status: CollectionModeStatus | null): void;
}) {
  useLocaleRevision();
  const [status, setStatus] = useState<CollectionModeStatus | null>(() => read(initialStatus));
  const [busy, setBusy] = useState(false);
  const [errorKind, setErrorKind] = useState<Exclude<ModeErrorKind, "not_confirmed" | "mode_switch_unavailable"> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [blocked, setBlocked] = useState<BlockedEntry | null>(() => readBlocked(collectionId));
  const [stepRetryAt, setStepRetryAt] = useState<string | undefined>(undefined);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandonError, setAbandonError] = useState<Exclude<ModeErrorKind, "not_confirmed" | "mode_switch_unavailable"> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const intent = useRef<{ target: Mode; id: string } | null>(null);
  const generation = useRef(0);
  const settledMode = useRef<Mode | null>(read(initialStatus)?.change ? null : read(initialStatus)?.current_mode ?? null);
  const hadPending = useRef<boolean>(Boolean(read(initialStatus)?.change && read(initialStatus)?.change?.phase !== "abandoned"));
  const abandonTrigger = useRef<HTMLButtonElement>(null);
  // Callback identity changes with parent renders; it must not restart I/O.
  const callbacks = useRef({ load, change, cancel, abandon, onModeChange, onStatusChange });
  callbacks.current = { load, change, cancel, abandon, onModeChange, onStatusChange };

  function applyStatus(next: CollectionModeStatus | null, incomingBlocked?: BlockedEntry | null) {
    setStatus(next);
    setNow(Date.now());
    callbacks.current.onStatusChange?.(next);
    if (!next) return;
    const isAbandoned = next.change?.phase === "abandoned";
    const isPending = Boolean(next.change && !isAbandoned);
    if (!isPending) intent.current = null;
    if (next.change?.phase !== "waiting_for_token_expiry") setStepRetryAt(undefined);
    if (incomingBlocked !== undefined) {
      setBlocked(incomingBlocked);
      writeBlocked(collectionId, incomingBlocked);
    } else {
      setBlocked((current) => {
        if (blockedStillApplies(current, next)) return current;
        writeBlocked(collectionId, null);
        return null;
      });
    }
    const previousMode = settledMode.current;
    const wasPending = hadPending.current;
    hadPending.current = isPending;
    if (!isPending) {
      settledMode.current = next.current_mode;
      if ((wasPending && (!next.change || isAbandoned)) || (previousMode !== null && previousMode !== next.current_mode)) {
        callbacks.current.onModeChange?.(next.current_mode);
      }
    }
  }

  useEffect(() => {
    const active = ++generation.current;
    const seeded = read(initialStatus);
    setStatus(seeded);
    setErrorKind(null);
    setLoadFailed(false);
    setBusy(false);
    setStepRetryAt(undefined);
    setAbandonOpen(false);
    setAbandonError(null);
    setNow(Date.now());
    const storedBlocked = readBlocked(collectionId);
    setBlocked(seeded && !blockedStillApplies(storedBlocked, seeded) ? null : storedBlocked);
    intent.current = null;
    settledMode.current = seeded && !seeded.change ? seeded.current_mode : null;
    hadPending.current = Boolean(seeded?.change && seeded.change.phase !== "abandoned");
    void callbacks.current.load().then((value) => {
      if (generation.current !== active) return;
      setLoadFailed(false);
      applyStatus(read(value));
    }).catch((error) => {
      if (generation.current !== active || !seeded) return;
      const kind = classifyModeError(error);
      if (kind === "mode_switch_unavailable") applyStatus(null, null);
      else if (kind !== "not_confirmed") {
        setLoadFailed(true);
        setErrorKind(kind);
      }
    });
    return () => { ++generation.current; };
  }, [collectionId]);

  const pendingPhase = status?.change && !["complete", "cancelled", "abandoned"].includes(status.change.phase)
    ? status.change.phase
    : null;

  useEffect(() => {
    if (!pendingPhase) return;
    const active = generation.current;
    const intervalMs = pendingPhase === "finishing" || pendingPhase === "publishing_policy"
      ? ACTIVE_POLL_MS
      : WAITING_POLL_MS;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (cancelled || active !== generation.current) return;
        try {
          const next = read(await callbacks.current.load());
          if (cancelled || active !== generation.current) return;
          if (next) applyStatus(next);
        } catch {
          // Background poll stays quiet and retries on the next interval.
        }
        if (!cancelled && active === generation.current) schedule();
      }, intervalMs);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [collectionId, pendingPhase]);

  async function refresh() {
    const active = generation.current;
    setBusy(true);
    setErrorKind(null);
    setLoadFailed(false);
    try {
      const next = read(await callbacks.current.load());
      if (active !== generation.current) return;
      applyStatus(next);
    } catch (error) {
      if (active !== generation.current) return;
      const kind = classifyModeError(error);
      if (kind === "mode_switch_unavailable") applyStatus(null, null);
      else if (kind !== "not_confirmed") {
        setLoadFailed(true);
        setErrorKind(kind);
      }
    } finally {
      if (active === generation.current) setBusy(false);
    }
  }

  async function commit(target: Mode) {
    const active = generation.current;
    if (intent.current?.target !== target) intent.current = { target, id: crypto.randomUUID() };
    setBusy(true);
    setErrorKind(null);
    setLoadFailed(false);
    setBlocked(null);
    writeBlocked(collectionId, null);
    setStepRetryAt(undefined);
    try {
      const result = await callbacks.current.change(target, intent.current.id);
      if (active !== generation.current) return;
      const step = result && typeof result === "object" ? result as Record<string, unknown> : null;
      const devices = step?.phase === "waiting_for_devices" && Array.isArray(step.devices)
        ? step.devices.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
      const retry = typeof step?.retry_at === "string" ? step.retry_at : undefined;
      const next = read(await callbacks.current.load());
      if (active !== generation.current) return;
      const names = blockedNames(step?.device_names, devices);
      const nextBlocked = devices.length > 0
        ? { ...(next?.change?.request_id ? { requestId: next.change.request_id } : {}), devices, ...(names ? { names } : {}) }
        : null;
      setStepRetryAt(retry);
      applyStatus(next, nextBlocked);
    } catch (error) {
      if (active !== generation.current) return;
      const kind = classifyModeError(error);
      if (kind === "not_confirmed") {
        if (!status?.change) intent.current = null;
        setErrorKind(null);
      } else if (kind === "mode_switch_unavailable") {
        applyStatus(null, null);
      } else if (kind === "mode_abandoned") {
        setErrorKind("mode_abandoned");
        void callbacks.current.load().then((value) => {
          if (active === generation.current) {
            const next = read(value);
            if (next) applyStatus(next, null);
          }
        }).catch(() => undefined);
      } else {
        setErrorKind(kind);
      }
    } finally {
      if (active === generation.current) setBusy(false);
    }
  }

  async function cancelPending() {
    if (!status?.change?.request_id || !callbacks.current.cancel) return;
    const active = generation.current;
    setBusy(true);
    setErrorKind(null);
    try {
      await callbacks.current.cancel(status.change.target_mode, status.change.request_id);
      const next = read(await callbacks.current.load());
      if (active !== generation.current) return;
      setStepRetryAt(undefined);
      intent.current = null;
      applyStatus(next, null);
    } catch (error) {
      if (active !== generation.current) return;
      const kind = classifyModeError(error);
      if (kind === "mode_switch_unavailable") {
        applyStatus(null, null);
      } else if (kind === "mode_already_published") {
        setErrorKind("mode_already_published");
        void callbacks.current.load().then((value) => {
          if (active === generation.current) {
            const next = read(value);
            if (next) applyStatus(next);
          }
        }).catch(() => undefined);
      } else if (kind !== "not_confirmed") {
        setErrorKind(kind);
      }
    } finally {
      if (active === generation.current) setBusy(false);
    }
  }

  async function abandonPending() {
    if (!status?.change?.request_id || !callbacks.current.abandon) return;
    const active = generation.current;
    setBusy(true);
    setErrorKind(null);
    setAbandonError(null);
    try {
      await callbacks.current.abandon(status.change.request_id);
      const next = read(await callbacks.current.load());
      if (active !== generation.current) return;
      setStepRetryAt(undefined);
      intent.current = null;
      setAbandonOpen(false);
      applyStatus(next, null);
    } catch (error) {
      if (active !== generation.current) return;
      const kind = classifyModeError(error);
      if (kind === "mode_switch_unavailable") {
        setAbandonOpen(false);
        applyStatus(null, null);
      } else if (kind === "mode_rekey_observed") {
        setAbandonError("mode_rekey_observed");
        void callbacks.current.load().then((value) => {
          if (active === generation.current) {
            const next = read(value);
            if (next) applyStatus(next);
          }
        }).catch(() => undefined);
      } else if (kind !== "not_confirmed") {
        setAbandonError(kind);
      }
    } finally {
      if (active === generation.current) setBusy(false);
    }
  }

  if (!status) return null;
  // Owner devices finish an abandoned Private switch by replacing the key;
  // leaving Private first would consume their switch, so nothing is offered.
  const abandoned = status.change?.phase === "abandoned";
  const pending = abandoned ? null : status.change;
  // GET /mode flips current_mode to cloud_copy at Private->Cloud /prepare before
  // services are keyed, so keep showing the source mode while a switch is pending.
  const displayedMode: Mode = pending
    ? (pending.source_mode ?? (pending.target_mode === "private" ? "cloud_copy" : "private"))
    : status.current_mode;
  const target: Mode = pending?.target_mode ?? (displayedMode === "private" ? "cloud_copy" : "private");
  const blockedIds = blocked?.devices ?? [];
  const retryAt = pending?.phase === "waiting_for_token_expiry" ? (pending.retry_at ?? stepRetryAt) : undefined;
  const finishLine = retryAt ? formatFinishTime(retryAt, now) : null;
  const needsNativeConsent = Boolean(
    pending && native && (pending.phase === "waiting_for_device" || pending.phase === "waiting_for_devices")
  );
  const canCancel = Boolean(
    cancel && pending?.request_id && ["waiting_for_device", "waiting_for_devices", "waiting_for_token_expiry"].includes(pending.phase)
  );
  const canAbandon = Boolean(
    abandon && pending?.request_id && pending.target_mode === "private" && pending.phase === "finishing"
  );
  const canRefresh = Boolean(loadFailed || errorKind === "unknown" || errorKind === "mode_rekey_observed");
  const showPrimaryAction = !abandoned && (!pending || needsNativeConsent);
  const hasActions = showPrimaryAction || canCancel || canAbandon || canRefresh;

  let progressLine: string | null = null;
  if (pending) {
    const toPrivate = pending.target_mode === "private";
    if (blockedIds.length > 0 || pending.phase === "waiting_for_devices") {
      progressLine = toPrivate
        ? t(i18n)({ message: "Switching to Private — waiting for older devices to update.", context: "Collection storage mode" })
        : t(i18n)({ message: "Switching to Cloud copy — waiting for older devices to update.", context: "Collection storage mode" });
    } else if (pending.phase === "waiting_for_token_expiry") {
      progressLine = toPrivate
        ? t(i18n)({ message: "Switching to Private — waiting for older app connections to expire.", context: "Collection storage mode" })
        : t(i18n)({ message: "Switching to Cloud copy — waiting for older app connections to expire.", context: "Collection storage mode" });
    } else if (pending.phase === "waiting_for_device") {
      progressLine = native
        ? (toPrivate
          ? t(i18n)({ message: "Switching to Private — confirm on this computer to start.", context: "Collection storage mode" })
          : t(i18n)({ message: "Switching to Cloud copy — confirm on this computer to start.", context: "Collection storage mode" }))
        : (toPrivate
          ? t(i18n)({ message: "Switching to Private — open mdbase connect on one of your computers to confirm.", context: "Collection storage mode" })
          : t(i18n)({ message: "Switching to Cloud copy — open mdbase connect on one of your computers to confirm.", context: "Collection storage mode" }));
    } else if (pending.phase === "publishing_policy") {
      progressLine = toPrivate
        ? t(i18n)({ message: "Switching to Private — publishing the new storage mode.", context: "Collection storage mode" })
        : t(i18n)({ message: "Switching to Cloud copy — publishing the new storage mode.", context: "Collection storage mode" });
    } else if (toPrivate) {
      progressLine = t(i18n)({ message: "Switching to Private — finishing and updating your collection key. This finishes automatically while an owner device is online.", context: "Collection storage mode" });
    } else {
      progressLine = t(i18n)({ message: "Switching to Cloud copy — finishing. This usually takes a few seconds.", context: "Collection storage mode" });
    }
  }

  return <section className="mdbase-collection-mode" aria-label={t(i18n)({ message: "Collection storage mode", context: "Collection storage mode" })} aria-busy={busy}>
    <h3>{t(i18n)({ message: "Storage mode", context: "Collection storage mode" })}</h3>
    <p className="mdbase-collection-mode-current">
      <strong>{displayedMode === "private"
        ? t(i18n)({ message: "Private", context: "Collection storage mode" })
        : t(i18n)({ message: "Cloud copy", context: "Collection storage mode" })}</strong>
      {" — "}
      {displayedMode === "private"
        ? t(i18n)({ message: "Only your devices can read it. Web apps work only while one of your devices is online.", context: "Collection storage mode" })
        : t(i18n)({ message: "mdbase keeps a copy it can read, so web apps and agents work while your devices are off.", context: "Collection storage mode" })}
    </p>
    {!abandoned && !pending && <p className="mdbase-collection-mode-note">{target === "private"
      ? t(i18n)({ message: "Switching to Private: only your devices can read new content; mdbase may still be able to read older content. Apps connected to this collection will need to be reconnected afterwards.", context: "Collection storage mode" })
      : t(i18n)({ message: "Switching to Cloud copy: mdbase will be able to read the collection, including its history. Apps connected to this collection will need to be reconnected afterwards.", context: "Collection storage mode" })}</p>}
    {abandoned && <p role="status">{t(i18n)({ message: "The switch to Private was stopped. This collection is Private on its previous key. Revoke the device that started the switch so your other owner devices replace the key automatically.", context: "Collection storage mode" })}</p>}
    {progressLine && <div className="mdbase-collection-mode-status">
      <p role="status">{progressLine}</p>
      {retryAt && finishLine && <p className="mdbase-collection-mode-note"><time dateTime={retryAt}>{finishLine}</time></p>}
    </div>}
    {blockedIds.length > 0 && <div className="mdbase-collection-mode-blocked" role="status">
      <p className="mdbase-collection-mode-note">{t(i18n)({ message: "Update mdbase on these devices or remove them before trying again:", context: "Collection storage mode" })}</p>
      <ul>{blockedIds.map((id) => {
        const name = blocked?.names?.[id] ?? deviceNames?.[id];
        const shortId = shortDeviceId(id);
        return <li key={id} title={id}>{name ?? t(i18n)({ message: `Device ${shortId}`, context: "Collection storage mode" })}</li>;
      })}</ul>
    </div>}
    {errorKind && <p role="alert">{errorText(errorKind)}</p>}
    {hasActions && <div className="mdbase-collection-mode-actions">
      {showPrimaryAction && <button type="button" className="mdbase-button" disabled={busy} onClick={() => void commit(target)}>
        {busy
          ? t(i18n)({ message: "Working…", context: "Collection storage mode" })
          : needsNativeConsent
            ? t(i18n)({ message: "Continue on this device", context: "Collection storage mode" })
            : target === "private"
              ? t(i18n)({ message: "Make private", context: "Collection storage mode" })
              : t(i18n)({ message: "Turn on Cloud copy", context: "Collection storage mode" })}
      </button>}
      {canCancel && <button type="button" className="mdbase-button is-tertiary" disabled={busy} onClick={() => void cancelPending()}>
        {t(i18n)({ message: "Cancel switch", context: "Collection storage mode" })}
      </button>}
      {canAbandon && <button ref={abandonTrigger} type="button" className="mdbase-button is-tertiary is-danger" disabled={busy} onClick={() => { setAbandonError(null); setAbandonOpen(true); }}>
        {t(i18n)({ message: "Stop this switch", context: "Collection storage mode" })}
      </button>}
      {canRefresh && <button type="button" className="mdbase-button is-tertiary" disabled={busy} onClick={() => void refresh()}>
        {t(i18n)({ message: "Refresh status", context: "Collection storage mode" })}
      </button>}
    </div>}
    {canAbandon && <ConfirmDialog
      open={abandonOpen}
      returnFocusRef={abandonTrigger}
      busy={busy}
      title={t(i18n)({ message: "Stop this switch to Private?", context: "Collection storage mode" })}
      consequence={t(i18n)({ message: "Use this only if the device that started the switch is lost and can’t finish. The collection stays Private on its current key, and your other owner devices replace the key automatically once you revoke the lost device.", context: "Collection storage mode" })}
      confirmLabel={t(i18n)({ message: "Stop this switch", context: "Collection storage mode" })}
      pendingLabel={t(i18n)({ message: "Stopping…", context: "Collection storage mode" })}
      onClose={() => { setAbandonError(null); setAbandonOpen(false); }}
      onConfirm={() => abandonPending()}
    >
      {abandonError && <p role="alert">{errorText(abandonError)}</p>}
    </ConfirmDialog>}
  </section>;
}
