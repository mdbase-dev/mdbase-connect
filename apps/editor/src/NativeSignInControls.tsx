import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConnectLayout } from "@mdbase-dev/ui/screens";
import { FeedbackButton } from "@mdbase-dev/ui/feedback";
import {
  SignInTabBlocked, authorizeNativeSignIn, signInCopy, signInPresentation,
  type NativeSignInBinding,
} from "./native-signin-ui";

export interface NativeConnectScreenProps {
  nativeSignIn: {
    /** The actual SDK session is borrowed; its caller owns its lifetime. */
    binding: NativeSignInBinding;
    onSignedOut(): void;
  };
}

/** Actions within the existing connection layout, not an auth/session engine. */
export function NativeSignInControls({ nativeSignIn: { binding, onSignedOut } }: NativeConnectScreenProps) {
  const { session, portal } = binding;
  const snapshot = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getSnapshot(),
    () => session.getSnapshot(),
  );
  const [problem, setProblem] = useState<"tab_blocked" | "interrupted" | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false), mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const foreground = () => {
      if (session.getSnapshot().status === "closed") return;
      try { session.setForeground(document.visibilityState === "visible"); }
      catch { if (mounted.current) setProblem("interrupted"); }
    };
    document.addEventListener("visibilitychange", foreground);
    if (session.getSnapshot().status !== "closed") {
      try { session.setForeground(document.visibilityState === "visible"); }
      catch { /* Retired owner; no late state publication. */ }
    }
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", foreground);
      portal.cancel();
      // The owner, not the view, closes this borrowed SDK session.
    };
  }, [session, portal]);
  useEffect(() => {
    // Account pairing alone can still require additional consent.
    if (["unselected", "opening", "setup_required", "ready", "blocked", "closed"].includes(snapshot.status)) portal.cancel();
  }, [portal, snapshot.status]);
  const act = async (action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true; setWorking(true); setProblem(null);
    try { await action(); }
    catch (reason) { if (mounted.current) setProblem(reason instanceof SignInTabBlocked ? "tab_blocked" : "interrupted"); }
    finally { if (mounted.current) { busy.current = false; setWorking(false); } }
  };
  const view = signInPresentation(snapshot, "mdbase editor", problem);
  const signOut = async () => {
    await session.close();
    portal.cancel();
    if (mounted.current) onSignedOut();
  };
  const authorize = () => authorizeNativeSignIn(session, portal);
  return <ConnectLayout app="editor" title={<>Your notes,<br />as files.</>}
    status={view.error ? undefined : view.message} error={view.error ? view.message : undefined}>
    {view.identity && <p className="mdbase-connect-status">{view.identity}</p>}
    {view.unavailable && <p className="mdbase-connect-footnote">{signInCopy.unavailable}</p>}
    {view.waiting
      ? <button type="button" className="mdbase-connect-action mdbase-button" disabled={working} onClick={() => void act(authorize)}>{signInCopy.reopen}</button>
      : (!view.paired || view.error) && <button type="button" className="mdbase-connect-action mdbase-button is-primary" disabled={working || view.disabled} onClick={() => void act(authorize)}>{view.action}</button>}
    {view.paired && <button type="button" className="mdbase-connect-action mdbase-button" disabled={working} onClick={() => void act(signOut)}>{signInCopy.signOut}</button>}
    {snapshot.selectedCollectionId && <button type="button" className="mdbase-connect-action mdbase-button" disabled={working} onClick={() => {
      const collectionId = snapshot.selectedCollectionId;
      if (collectionId) void act(() => session.forget(collectionId));
    }}>Forget collection</button>}
    <FeedbackButton />
  </ConnectLayout>;
}
