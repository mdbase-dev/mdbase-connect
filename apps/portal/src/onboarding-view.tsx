import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { message } from "./portal-model";
import { MinimalAuthPage } from "./auth-view";

interface StarterCollectionResponse {
  status: "pending" | "ready" | "deleted";
  collection_id?: string;
  editor_url?: string | null;
}

export function GettingStarted() {
  useLocaleRevision();
  const [error, setError] = useState("");
  const requestInFlight = useRef(false);
  const retryTimer = useRef<number | null>(null);

  function prepare() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setError("");
    void api<StarterCollectionResponse>("/v1/onboarding/starter-collection", {
      method: "POST"
    }).then((result) => {
      requestInFlight.current = false;
      if (result.status === "pending") {
        retryTimer.current = window.setTimeout(prepare, 750);
        return;
      }
      if (result.status === "deleted") {
        location.replace("/");
        return;
      }
      if (!result.editor_url && !result.collection_id) throw new Error(t(i18n)`The collection could not be opened.`);
      location.replace(result.editor_url || `/collections/${encodeURIComponent(result.collection_id!)}`);
    }).catch((reason) => {
      requestInFlight.current = false;
      // The legacy starter endpoint emits onboarding_moved. The other codes
      // anticipate /v1/next/onboarding/starter-collection (quota support: #1036).
      // Remove those compatibility cases when the portal calls the native route
      // and handles its refusals there.
      if (reason instanceof ApiError && (
        (reason.status === 409 && (reason.code === "onboarding_moved" || reason.code === "starter_unavailable"))
        || (reason.status === 503 && reason.code === "starter_content_unavailable")
        || (reason.status === 429 && reason.code === "account_collection_quota_exceeded")
      )) {
        location.replace("/");
        return;
      }
      setError(message(reason));
    });
  }

  useEffect(() => {
    prepare();
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, []);

  return (
    <MinimalAuthPage>
      <section className="mdbase-page-panel onboarding-panel" aria-live="polite">
        <h1>{error ? <Trans>We couldn't create your collection</Trans> : <Trans>Creating your first collection</Trans>}</h1>
        <p>{error ? <Trans>Your account is ready. Create a collection now, or continue without one.</Trans> : <Trans>We’re creating a small private Markdown collection. It will open when it’s ready.</Trans>}</p>
        {!error && <div className="onboarding-progress" aria-hidden="true"><span /></div>}
        <div className="onboarding-actions">
          {error && <>
          <p className="mdbase-message is-error" role="alert">{error}</p>
          <button className="mdbase-button is-primary" type="button" onClick={prepare}><Trans>Try again</Trans></button>
          </>}
          <a className="quiet-auth-link" href="/"><Trans>Continue without it</Trans></a>
        </div>
      </section>
    </MinimalAuthPage>
  );
}
