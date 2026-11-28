import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { t } from "@lingui/core/macro";
import { connectDirect, createDirectGrantStore, directBackendOrigin, pairDirect, type DirectBrowserGrant } from "@mdbase-dev/sdk-self-hosted/direct";
import { backendHost, invitationServer, onPairInvitation } from "./invitation";
import { RecordWorkspace, type DirectClient, type UnsavedText } from "./RecordWorkspace";

const store = createDirectGrantStore("editor");
type Screen = { kind: "busy" | "pair"; message?: string } |
  { kind: "retry"; grant: DirectBrowserGrant; message: string } |
  { kind: "open"; grant: DirectBrowserGrant; client: DirectClient; message?: string };

function denied(error: unknown) { return !!error && typeof error === "object" && "code" in error && error.code === "unauthenticated"; }
function codeUnused(error: unknown) { return !!error && typeof error === "object" && "reason" in error && error.reason === "code_not_sent"; }
function normalize(address: string) {
  return directBackendOrigin(address.includes("#mdbase-pair") ? invitationServer(address, location.origin) : address);
}
function hasBrowserTransport(server: string) {
  return server.includes("#") ? typeof WebTransport === "function" && typeof WebTransport.prototype.createBidirectionalStream === "function" : typeof WebSocket === "function";
}
const unsupported = () => t`This browser cannot connect to this server. Open the invitation in a browser that supports its transport.`;
function connectionHelp(server: string, message: string) {
  return server.includes("#") ? [message, t`If the browser asked, allow local network access for this site.`].join(" ") : message;
}
const badAddress = () => t`Enter a server HTTPS address or an invitation for this editor.`;
const mismatch = () => t`A different connection is saved. Reconnect to the saved server or forget it before pairing.`;

export function DirectEditor({ allowed, signal, invitation, invalidInvitation }: {
  invitation?: string; invalidInvitation?: boolean; allowed(): Promise<boolean>; signal: AbortSignal;
}) {
  const [screen, show] = useState<Screen>({ kind: "busy" });
  const current = useRef(screen);
  const [address, setAddress] = useState(invitation ?? "");
  const [pairingError, setPairingError] = useState(false);
  const [remember, setRemember] = useState(false);
  const [supportsPins, setSupportsPins] = useState(true);
  function supported(server: string) {
    return hasBrowserTransport(server) && (supportsPins || !server.includes("#"));
  }
  function missingPins(error: unknown) {
    if (!error || typeof error !== "object" || !("reason" in error) || error.reason !== "browser_unsupported") return false;
    setSupportsPins(false);
    return true;
  }

  const [addressError, setAddressError] = useState(false);
  const [recovery, setRecovery] = useState<UnsavedText>();
  const readDraft = useRef<() => UnsavedText | undefined>(undefined);
  const pairingInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const disconnect = useRef<(() => void) | undefined>(undefined);
  let server: string | undefined;
  try { server = normalize(address.trim()); } catch { /* Validate on submission. */ }
  const pinned = !!server?.includes("#");
  function transition(next: Screen) {
    if (!signal.aborted) { current.current = next; show(next); }
  }
  function close() {
    const text = readDraft.current?.();
    if (text) setRecovery(text);
    disconnect.current?.();
    disconnect.current = undefined;
  }
  useEffect(() => {
    const target = screen.kind === "pair"
      ? (pinned || (server && screen.message) ? pairingInput.current : document.getElementById("backend")) : null;
    (target ?? heading.current)?.focus();
  }, [screen, pinned]); // Address validation focuses its own field.

  useEffect(() => {
    if (!recovery) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recovery]);

  async function remove(grant: DirectBrowserGrant, message: string) {
    close();
    transition({ kind: "busy" });
    try {
      if (grant.receipt) {
        if (!await allowed()) return;
        await store.forget(grant.receipt);
        const remaining = await store.read();
        if (remaining) { transition({ kind: "retry", grant: remaining, message: mismatch() }); return; }
      }
      transition({ kind: "pair", message });
    } catch {
      transition({ kind: "retry", grant, message: t`Could not remove the saved connection. Try forgetting it again.` });
    }
  }
  function forget(grant: DirectBrowserGrant) {
    if (!window.confirm(grant.receipt
      ? t`Forget this browser and disconnect? To revoke access on the server, ask the person who paired you.`
      : t`Disconnect this tab? You will need a new code to pair again.`)) return;
    void remove(grant, grant.receipt ? t`This browser forgot the connection. The server still controls the grant.` : t`Disconnected.`);
  }
  async function lost(error: unknown, grant: DirectBrowserGrant) {
    if (signal.aborted) return;
    if (denied(error)) {
      await remove(grant, t`Access was refused or revoked. Ask for a new pairing code.`);
    } else {
      close();
      transition({ kind: "retry", grant, message: missingPins(error) ? unsupported() : connectionHelp(grant.server, t`Connection lost. Check the server and network, then reconnect.`) });
    }
  }
  async function open(grant: DirectBrowserGrant, message?: string) {
    transition({ kind: "busy" });
    if (!supported(grant.server)) { transition({ kind: "retry", grant, message: unsupported() }); return; }
    try {
      if (!await allowed()) return;
      const client = await connectDirect({ server: grant.server, token: grant.token, signal, app: { name: "mdbase-editor", version: "1" } });
      if (signal.aborted) { client.close(); return; }
      const off = client.onLink((link, error) => {
        if (link === "closed" && current.current.kind === "open" && current.current.client === client) void lost(error, grant);
      });
      disconnect.current = () => { off(); client.close(); };
      if (client.link !== "open") { await lost(client.linkProblem, grant); return; }
      transition({ kind: "open", client, grant, message });
    } catch (error) { await lost(error, grant); }
  }
  async function restore(requested?: string, expected?: DirectBrowserGrant) {
    transition({ kind: "busy" });
    try {
      if (!await allowed()) return;
      const grant = await store.read();
      if (!grant) { transition({ kind: "pair" }); return; }
      if (!grant.receipt) throw Error("Missing saved receipt");
      if ((requested && requested !== grant.server) || (expected && expected.receipt !== grant.receipt)) {
        transition({ kind: "retry", grant, message: mismatch() });
      } else await open(grant);
    } catch {
      transition({ kind: "pair", message: t`Browser storage is unavailable. Pair without remembering this browser.` });
    }
  }
  function reconnect(grant: DirectBrowserGrant) {
    if (grant.receipt) void restore(undefined, grant);
    else void open(grant);
  }
  const receive = useEffectEvent((descriptor?: string) => {
    let next: string;
    try { next = normalize(descriptor ?? ""); } catch {
      if (current.current.kind === "pair") {
        changeAddress("");
        setAddressError(true);
      }
      return;
    }
    const active = current.current;
    if (active.kind === "busy" || (active.kind === "open" && active.grant.server === next)) return;
    if (active.kind === "pair" && server === next) return;
    if (active.kind === "retry" && active.grant.server === next) {
      reconnect(active.grant);
      return;
    }
    if (active.kind === "open" || active.kind === "retry") {
      const host = backendHost(next);
      if (!window.confirm(t`Open the invitation from ${host}?`)) return;
      close();
    }
    changeAddress(next);
    void restore(next);
  });
  useEffect(() => {
    try {
      if (invalidInvitation) throw Error("Invalid invitation");
      void restore(invitation && normalize(invitation));
    } catch { setAddressError(true); transition({ kind: "pair" }); }
    const off = onPairInvitation(receive);
    const stop = () => disconnect.current?.();
    signal.addEventListener("abort", stop);
    return () => { off(); signal.removeEventListener("abort", stop); stop(); };
  }, []);

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (current.current.kind !== "pair") return;
    if (!server) { setAddressError(true); document.getElementById("backend")?.focus(); return; }
    if (!supported(server)) return;
    const field = pairingInput.current!;
    const code = field.value.replace(/[\s-]/gu, "");
    if (!/^[0-9]{8}$/u.test(code)) {
      setPairingError(true);
      field.focus();
      return;
    }
    setPairingError(false);
    field.value = "";
    transition({ kind: "busy" });
    try {
      if (!await allowed()) return;
      const token = await pairDirect({ server, code, signal });
      let receipt: string | undefined;
      let message: string | undefined;
      if (remember) {
        if (!await allowed()) return;
        try { receipt = await store.save({ server, token }); }
        catch { message = t`Paired for this tab only. The connection could not be remembered.`; }
      }
      await open({ server, token, receipt }, message);
    } catch (error) {
      if (missingPins(error)) { transition({ kind: "pair" }); return; }
      transition({ kind: "pair", message: denied(error) ? t`The pairing code was refused. Check the digits or ask for a new code if it expired.`
        : connectionHelp(server, codeUnused(error) ? t`The server was not reached, so your code was not used. Check the server and network, then enter the code again.`
          : t`Pairing could not be confirmed. Check the server and network before trying again.`) });
    }
  }
  function changeAddress(value: string) {
    setAddress(value);
    setAddressError(false);
    setPairingError(false);
    if (pairingInput.current) pairingInput.current.value = "";
  }
  return <><header><p className="product">mdbase editor{" · "}{t`Advanced`}</p>
    <h1 ref={heading} tabIndex={-1}>{screen.kind === "open" ? t`Your collection` : t`Connect to your own server`}</h1>
  </header>
    {recovery && <section className="recovery"><label>{t`Unsaved text`} · {recovery.path}
      <textarea readOnly value={recovery.body} onFocus={event => event.currentTarget.select()} /></label>
      <p>{t`Copy your text before closing this tab. It will not be sent when you reconnect.`}</p>
      <button onClick={() => { if (window.confirm(t`Discard unsaved changes?`)) setRecovery(undefined); }}>{screen.kind === "open" ? t`Discard and open notes` : t`Discard unsaved text`}</button>
    </section>}
    {screen.message && <p role="status">{screen.message}</p>}
    {screen.kind === "busy" ? <p role="status">{t`Connecting…`}</p> : screen.kind === "open" || screen.kind === "retry" ? <>
      <div className="session"><strong>{backendHost(screen.grant.server)}</strong>
        {screen.kind === "retry" && <button disabled={!supported(screen.grant.server)} onClick={() => reconnect(screen.grant)}>{t`Reconnect`}</button>}
        <button onClick={() => forget(screen.grant)}>{screen.grant.receipt ? t`Forget this browser` : t`Disconnect`}</button></div>
      {screen.kind === "retry" && server && server !== screen.grant.server && <p>{t`Invitation`} · {backendHost(server)}</p>}
      {screen.kind === "open" && !recovery && <RecordWorkspace client={screen.client} readDraft={readDraft} discard={() => {
        // Releasing a dirty record lease retains it in that client. A confirmed discard
        // opens a fresh client, including when the original save outcome was uncertain.
        disconnect.current?.();
        disconnect.current = undefined;
        reconnect(screen.grant);
      }} />}
    </> : <form onSubmit={pair} noValidate>
      {pinned ? <div><strong>{backendHost(server!)}</strong>{" "}<button type="button" onClick={() => changeAddress("")}>{t`Change server`}</button></div> :
        <label>{t`Server address or invitation link`}<input id="backend" type="url" value={address}
          aria-invalid={addressError} aria-describedby={addressError ? "address-error" : undefined}
          onChange={event => changeAddress(event.target.value)} required spellCheck={false} autoComplete="off" /></label>}
      {addressError && <p id="address-error" role="alert">{badAddress()}</p>}
      {server && !supported(server) ? <p role="alert">{unsupported()}</p> : <>
        {!pinned && server && <strong>{backendHost(server)}</strong>}
        <p>{t`Check the server address with the person who gave you the code. Pairing lets this editor read and edit notes while connected.`}</p>
        <label>{t`8-digit pairing code`}<input ref={pairingInput} id="pairing" type="text" autoComplete="one-time-code"
          inputMode="numeric" required aria-invalid={pairingError}
          aria-describedby={pairingError ? "pairing-error" : undefined} onChange={() => setPairingError(false)} /></label>
        {pairingError && <p id="pairing-error" role="alert">{t`Enter the eight-digit pairing code.`}</p>}
        <label className="checkbox"><input id="remember" type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
          {t`Remember this browser`}</label>
        <small>{t`Without this option, reloading the page requires a new code.`}</small>
        <button type="submit">{t`Pair and open collection`}</button>
      </>}
    </form>}
  </>;
}
