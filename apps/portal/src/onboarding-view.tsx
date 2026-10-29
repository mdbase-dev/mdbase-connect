import { Trans } from "@lingui/react/macro";
import { useLocaleRevision } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { message } from "./portal-model";
import { PageBrand } from "./portal-ui";

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
      location.replace(result.editor_url ?? "/");
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
    <main className="center-page">
      <PageBrand label="connect" markMotion="sort" error={error} />
      <section className="auth-panel onboarding-panel" aria-live="polite">
        <p className="eyebrow"><Trans>Your first collection</Trans></p>
        <h1><Trans>Preparing a place to start.</Trans></h1>
        <p><Trans>We’re creating a small private Markdown collection, then we’ll open it in the editor.</Trans></p>
        {!error && <div className="onboarding-progress" aria-hidden="true"><span /></div>}
        {error && <>
          <div className="message error" role="alert">{error}</div>
          <button className="button primary" type="button" onClick={prepare}><Trans>Try again</Trans></button>
          <a className="quiet-auth-link" href="/"><Trans>Open mdbase Connect without it</Trans></a>
        </>}
      </section>
    </main>
  );
}
