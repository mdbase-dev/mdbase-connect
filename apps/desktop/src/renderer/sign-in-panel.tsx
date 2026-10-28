import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useState } from "react";
import { accountProblemText } from "./daemon-view.mjs";
import { markPairingCompleted } from "./onboarding-state.mjs";
import { StatusDot } from "./ui-components";
import { message } from "./view-model";

const POLL_MS = 2_000;

/**
 * Sign this computer in to mdbase. The daemon owns the sign-in: it returns an
 * approval page, and its status reports `pairing` until the browser approves and
 * `signed_in` afterwards. Nothing restarts; collections can be added once signed in.
 */
export function SignInPanel({ cloud, resumeAuthorization = false, reason, onSignedIn }: {
  cloud: CloudSetting;
  resumeAuthorization?: boolean;
  /** Why sign-in is needed now, for example after trying to add a collection. */
  reason?: string | null;
  onSignedIn(): void;
}) {
  useLocaleRevision();
  const [account, setAccount] = useState<CloudSetting>(cloud);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => setAccount(cloud), [cloud]);

  const waiting = account.pairing ?? null;
  useEffect(() => {
    if (!waiting) return;
    let active = true;
    const timer = window.setInterval(() => {
      void window.mdbaseConnect.getCloudConfig().then((next) => {
        if (!active) return;
        setAccount(next);
        if (next.configured && !next.pairing) {
          markPairingCompleted(localStorage);
          onSignedIn();
        } else if (!next.pairing && next.lastError) {
          setFailure(accountProblemText(next.lastError) ?? "");
        }
      }).catch(() => undefined);
    }, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [waiting, onSignedIn]);

  async function begin() {
    setStarting(true);
    setFailure("");
    try {
      const started = await window.mdbaseConnect.signIn();
      setAccount((current) => ({ ...current, pairing: started.verificationUri, lastError: null }));
    } catch (error) {
      setFailure(message(error));
    } finally {
      setStarting(false);
    }
  }

  const problem = failure || (!waiting && accountProblemText(account.lastError)) || "";
  return (
    <section className="pairing-panel" aria-label={t(i18n)({ message: "Sign in", context: "Connect interface" })}>
      <div className="pairing-intro">
        <h2>{waiting ? t(i18n)({ message: "Finish in your browser.", context: "Connect interface" }) : t(i18n)({ message: "Sign in to mdbase on this computer" })}</h2>
        <p>{waiting
          ? t(i18n)({ message: "Approve this computer in your browser. This window updates automatically." })
          : resumeAuthorization
            ? t(i18n)({ message: "Your application request will keep waiting. Sign in so you can choose a folder on this computer, then continue the same request." })
            : t(i18n)({ message: "Sign in before adding collections, so your apps can reach them through this computer. Your folders stay on this computer and their locations stay private." })}</p>
      </div>
      <div>
        {reason && !waiting && <div className="message notice-message" role="status">{reason}</div>}
        {problem && <div className="message error-message" role="alert">{problem}</div>}
        {waiting ? (
          <div className="pairing-wait" role="status" aria-live="polite">
            <StatusDot state="connecting" />
            <div>
              <strong><Trans>Waiting for browser approval</Trans></strong>
              <code>{waiting}</code>
            </div>
            <div>
              <button className="quiet-action" onClick={() => void window.mdbaseConnect.reopenSignIn().catch((error) => setFailure(message(error)))}><Trans>Open browser again</Trans></button>
              <button className="quiet-action" disabled={starting} onClick={() => void begin()}><Trans>Start again</Trans></button>
            </div>
          </div>
        ) : (
          <button className="button primary" disabled={starting} onClick={() => void begin()}>{starting ? t(i18n)({ message: "Opening browser…", context: "Connect interface" }) : t(i18n)({ message: "Sign in with your browser" })}</button>
        )}
      </div>
    </section>
  );
}
