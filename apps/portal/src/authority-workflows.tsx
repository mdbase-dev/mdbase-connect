import React, { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type AuthorityTransfer as AuthorityTransferData
} from "./api";
import { message } from "./portal-model";
import { Loading, PageBrand } from "./portal-ui";

export function Pairing({ pairingId }: { pairingId: string }) {
  const [pairing, setPairing] = useState<{ connector_name: string; approved_at: string | null } | null>(null);
  const [deepLink, setDeepLink] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ pairing: { connector_name: string; approved_at: string | null } }>(`/v1/pairing-requests/${pairingId}`)
      .then((value) => setPairing(value.pairing))
      .catch((reason) => {
        if (reason instanceof ApiError && reason.status === 401) location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else setError(message(reason));
      });
  }, [pairingId]);

  async function approve() {
    try {
      const result = await api<{ deep_link: string }>(`/v1/pairing-requests/${pairingId}/approve`, { method: "POST" });
      setDeepLink(result.deep_link);
    } catch (approveError) { setError(message(approveError)); }
  }

  if (!pairing) return <Loading error={error} />;
  return (
    <main className="center-page">
      <PageBrand label="Computer pairing" />
      <section className="decision-panel">
        {deepLink ? <><p className="eyebrow">Computer approved</p><h1>Return to mdbase connect.</h1><p>The desktop app will finish securely. No connector token was displayed or copied.</p><a className="button primary link-button" href={deepLink}>Open mdbase connect</a></> : <><p className="eyebrow">New computer</p><h1>{pairing.connector_name}</h1><p>Allow this computer to connect to your account. It will publish collection names and route application requests, but not local folder paths.</p>{error && <div className="message error">{error}</div>}<div className="decision-actions"><a className="button secondary link-button" href="/">Cancel</a><button className="button primary" onClick={() => void approve()}>Approve computer</button></div></>}
      </section>
    </main>
  );
}

export function MirrorPairing({ pairingId }: { pairingId: string }) {
  const [request, setRequest] = useState<{
    pairing: {
      mirror_name: string;
      mode: "read_only" | "read_write";
      collection_hint?: string | null;
      collection_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
    };
    collections: Array<{ id: string; display_name: string }>;
  } | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<NonNullable<typeof request>>(`/v1/mirror-pairing-requests/${pairingId}`)
      .then((value) => {
        setRequest(value);
        setApproved(Boolean(value.pairing.approved_at));
        const preferred = value.collections.some(
          (collection) => collection.id === value.pairing.collection_hint
        )
          ? value.pairing.collection_hint!
          : value.collections[0]?.id ?? "";
        setCollectionId(value.pairing.collection_id ?? preferred);
      })
      .catch((reason) => {
        if (reason instanceof ApiError && reason.status === 401) {
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        } else {
          setError(message(reason));
        }
      });
  }, [pairingId]);

  async function approve() {
    if (!collectionId) return;
    setBusy(true);
    try {
      await api(`/v1/mirror-pairing-requests/${pairingId}/approve`, {
        method: "POST",
        body: JSON.stringify({ collection_id: collectionId })
      });
      setApproved(true);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!request) return <Loading error={error} />;
  const selected = request.collections.find((collection) => collection.id === collectionId);
  return (
    <main className="center-page">
      <PageBrand label="Folder sync" />
      <section className="decision-panel">
        {approved ? <>
          <p className="eyebrow outcome-label">Folder approved</p>
          <h1>Return to your computer.</h1>
          <p>
            {selected?.display_name ?? "The collection"} will begin syncing automatically.
            You can close this page.
          </p>
        </> : <>
          <p className="eyebrow">New synced folder</p>
          <h1>{request.pairing.mirror_name}</h1>
          <p>
            {request.pairing.mode === "read_write"
              ? "Markdown edits will sync in both directions. Concurrent edits remain separate until you choose a version."
              : "This folder will receive Markdown from mdbase and will not upload local edits."}
          </p>
          {error && <div className="message error" role="alert">{error}</div>}
          {request.collections.length ? <>
            <label>
              <span>Hosted collection</span>
              <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
                {request.collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>{collection.display_name}</option>
                ))}
              </select>
            </label>
            <p className="field-note">
              Existing Markdown is checked before upload. Collection paths and device credentials stay off the control plane.
            </p>
            <div className="decision-actions">
              <a className="button secondary link-button" href="/">Cancel</a>
              <button className="button primary" disabled={busy || !collectionId} onClick={() => void approve()}>
                {busy ? "Approving…" : "Sync this collection"}
              </button>
            </div>
          </> : <>
            <div className="message">Create a hosted collection before approving this folder.</div>
            <div className="decision-actions">
              <a className="button primary link-button" href="/">Open your collections</a>
            </div>
          </>}
        </>}
      </section>
    </main>
  );
}

export function AuthorityAdoption({ adoptionId }: { adoptionId: string }) {
  const [adoption, setAdoption] = useState<{
    id: string;
    collection_id: string;
    display_name: string;
    source_name: string;
    retain_mirror: boolean;
    mirror_name: string | null;
    state: "requested" | "approved" | "prepared" | "activating" | "completed" | "cancelled" | "expired";
    authority_epoch: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const result = await api<{ adoption: NonNullable<typeof adoption> }>(
        `/v1/authority-adoptions/${adoptionId}`
      );
      setAdoption(result.adoption);
      setError("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
      } else {
        setError(message(reason));
      }
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [adoptionId]);

  async function approve() {
    setBusy(true);
    try {
      const result = await api<{ adoption: NonNullable<typeof adoption> }>(
        `/v1/authority-adoptions/${adoptionId}/approve`,
        { method: "POST", body: "{}" }
      );
      setAdoption(result.adoption);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!adoption) return <Loading error={error} />;
  const inactive = adoption.state === "cancelled" || adoption.state === "expired";
  return (
    <main className="center-page">
      <PageBrand label="Move collection online" />
      <section className="decision-panel authority-decision">
        {adoption.state === "completed" ? <>
          <p className="eyebrow outcome-label">Move complete</p>
          <h1>{adoption.display_name} is now hosted.</h1>
          <p>
            mdbase now keeps the main copy of this collection.
            {adoption.retain_mirror
              ? ` ${adoption.mirror_name ?? adoption.source_name} will continue as a synced folder, with edits syncing both ways.`
              : " The original local files are no longer the main copy."}
          </p>
          <div className="transfer-status" role="status">
            <span className="status-dot connected" aria-hidden="true" />
            <span>Main copy hosted by mdbase</span>
          </div>
          <a className="button primary link-button" href="/">Return to your account</a>
        </> : inactive ? <>
          <p className="eyebrow">Move ended</p>
          <h1>Your local collection was kept.</h1>
          <p>The main copy was not moved to mdbase.</p>
          {error && <div className="message error" role="alert">{error}</div>}
          <a className="button primary link-button" href="/">Return to your account</a>
        </> : adoption.state !== "requested" ? <>
          <p className="eyebrow outcome-label">Move approved</p>
          <h1>Return to {adoption.source_name}.</h1>
          <p>
            The app is uploading and checking a final collection snapshot.
            The main copy will move only after that exact snapshot is complete.
          </p>
          <div className="transfer-status" role="status">
            <span className="status-dot paused" aria-hidden="true" />
            <span>{adoption.state === "activating" ? "Finishing the move" : "Waiting for the app"}</span>
          </div>
          {error && <div className="message error" role="alert">{error}</div>}
        </> : <>
          <p className="eyebrow">Move a local collection to mdbase</p>
          <h1>{adoption.display_name}</h1>
          <p>
            Approving uploads the complete collection from {adoption.source_name}, validates it
            as one snapshot, and then makes the hosted version the main copy.
          </p>
          <div className="message">
            {adoption.retain_mirror
              ? `After the move, ${adoption.mirror_name ?? adoption.source_name} stays as a synced folder. It will not be a second main copy.`
              : "After the move, the original local files are no longer the main copy."}
          </div>
          {error && <div className="message error" role="alert">{error}</div>}
          <div className="decision-actions">
            <a className="button secondary link-button" href="/">Cancel</a>
            <button className="button primary" disabled={busy} onClick={() => void approve()}>
              {busy ? "Approving…" : "Move this collection"}
            </button>
          </div>
        </>}
      </section>
    </main>
  );
}

export function AuthorityTransfer({ transferId }: { transferId: string }) {
  const [transfer, setTransfer] = useState<AuthorityTransferData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const result = await api<{ transfer: AuthorityTransferData }>(
        `/v1/authority-transfers/${transferId}`
      );
      setTransfer(result.transfer);
      setError("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
      } else {
        setError(message(reason));
      }
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [transferId]);

  async function approve() {
    setBusy(true);
    try {
      const result = await api<{ transfer: AuthorityTransferData }>(
        `/v1/authority-transfers/${transferId}/approve`,
        { method: "POST", body: "{}" }
      );
      setTransfer(result.transfer);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api(`/v1/authority-transfers/${transferId}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!transfer) return <Loading error={error} />;
  const collectionName = transfer.collection_name ?? "This collection";
  const mirrorName = transfer.mirror_name ?? "the selected computer";
  const waiting = transfer.state === "approved" || transfer.state === "prepared";
  const inactive = transfer.state === "cancelled" || transfer.state === "expired";
  return (
    <main className="center-page">
      <PageBrand label="Move main copy" />
      <section className="decision-panel authority-decision">
        {transfer.state === "completed" ? <>
          <p className="eyebrow outcome-label">Transfer complete</p>
          <h1>{collectionName} now lives on your computer.</h1>
          <p>
            The folder on {mirrorName} is now the main copy. Hosted access has stopped
            and previous application connections were revoked.
          </p>
          <div className="transfer-status" role="status">
            <span className="status-dot connected" aria-hidden="true" />
            <span>Main copy on {mirrorName}</span>
          </div>
          <a className="button primary link-button" href="/">Return to your account</a>
        </> : inactive ? <>
          <p className="eyebrow">Transfer ended</p>
          <h1>The main copy stayed hosted.</h1>
          <p>
            {collectionName} remains hosted. Its main copy did not move.
          </p>
          {error && <div className="message error" role="alert">{error}</div>}
          <a className="button primary link-button" href="/">Return to your account</a>
        </> : waiting ? <>
          <p className="eyebrow outcome-label">Transfer approved</p>
          <h1>Return to {mirrorName}.</h1>
          <p>
            mdbase connect is checking the latest hosted changes, registering the folder,
            and making it the main copy.
          </p>
          <div className="transfer-status" role="status">
            <span className="status-dot paused" aria-hidden="true" />
            <span>{transfer.state === "prepared" ? "Hosted writes are paused" : "Waiting for the computer"}</span>
          </div>
          {error && <div className="message error" role="alert">{error}</div>}
          <div className="decision-actions">
            <button className="quiet-danger" disabled={busy} onClick={() => void cancel()}>
              Cancel transfer
            </button>
          </div>
        </> : <>
          <p className="eyebrow">Move the main copy</p>
          <h1>Use the folder on {mirrorName} as the main copy?</h1>
          <p>
            {collectionName} will stop being hosted and become a computer-owned collection.
            This changes where every future edit is accepted.
          </p>
          <dl className="transfer-consequences">
            <div><dt>Folder</dt><dd>The synced Markdown folder becomes the main copy.</dd></div>
            <div><dt>Hosted service</dt><dd>Writes pause during verification, then hosted access is retired.</dd></div>
            <div><dt>Applications</dt><dd>Existing access is revoked. Connect applications again to use the local collection.</dd></div>
            <div><dt>Recovery</dt><dd>If verification fails or this request expires, hosted writes resume.</dd></div>
          </dl>
          {error && <div className="message error" role="alert">{error}</div>}
          <div className="decision-actions">
            <button className="button secondary" disabled={busy} onClick={() => void cancel()}>
              Keep it hosted
            </button>
            <button className="button primary" disabled={busy} onClick={() => void approve()}>
              {busy ? "Approving…" : "Move main copy"}
            </button>
          </div>
        </>}
      </section>
    </main>
  );
}

