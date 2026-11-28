import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useState } from "react";
import { accountProblemText, type CloudSetting } from "./daemon-view.mjs";
import { StatusDot } from "./ui-components";
import { message } from "./view-model";

/**
 * Sign this computer in to mdbase. The daemon owns the sign-in: it returns an
 * approval page, and its status reports `pairing` until the browser approves and
 * `signed_in` afterwards. Nothing restarts; collections can be added once signed in.
 */
export function SignInPanel({ cloud, resumeAuthorization = false, reason, onPairing }: {
  cloud: CloudSetting;
  resumeAuthorization?: boolean;
  /** Why sign-in is needed now, for example after trying to add a collection. */
  reason?: string | null;
  onPairing(uri: string): void;
}) {
  useLocaleRevision();
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState("");
  const waiting = cloud.pairing;

  async function begin() {
    setStarting(true);
    setFailure("");
    try {
      const started = await window.mdbaseConnect.signIn();
      onPairing(started.verificationUri);
    } catch (error) {
      setFailure(message(error));
    } finally {
      setStarting(false);
    }
  }

  const problem = failure || (!waiting && accountProblemText(cloud.lastError)) || "";
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
        {reason && !waiting && <div className="mdbase-message is-success" role="status">{reason}</div>}
        {problem && <div className="mdbase-message is-error" role="alert">{problem}</div>}
        {waiting ? (
          <div className="pairing-wait" role="status" aria-live="polite">
            <StatusDot state="connecting" />
            <div>
              <strong><Trans>Waiting for browser approval</Trans></strong>
              <code>{waiting}</code>
            </div>
            <div>
              <button className="mdbase-button is-tertiary" onClick={() => void window.mdbaseConnect.reopenSignIn().catch((error) => setFailure(message(error)))}><Trans>Open browser again</Trans></button>
              <button className="mdbase-button is-tertiary" disabled={starting} onClick={() => void begin()}><Trans>Start again</Trans></button>
            </div>
          </div>
        ) : (
          <button className="mdbase-button is-primary" disabled={starting} onClick={() => void begin()}>{starting ? t(i18n)({ message: "Opening browser…", context: "Connect interface" }) : t(i18n)({ message: "Sign in with your browser" })}</button>
        )}
      </div>
    </section>
  );
}
