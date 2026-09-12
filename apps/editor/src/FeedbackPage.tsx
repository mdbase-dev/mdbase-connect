import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ConnectPage as Page, ConnectSectionTitle as SectionTitle } from "./ConnectPrimitives";
import { Turnstile } from "./Turnstile";
import {
  FEEDBACK_MAX_MESSAGE_LENGTH,
  buildFeedbackDiagnostics,
  readFeedbackScreenshot,
  sendFeedback,
  type FeedbackScreenshot,
  type FeedbackSourceView,
  type FeedbackTopic
} from "./feedback";

export function FeedbackPage({ endpoint, turnstileSiteKey, sourceView, collectionName, applicationOrigins, onDone }: {
  endpoint: string;
  turnstileSiteKey: string | null;
  sourceView: FeedbackSourceView;
  collectionName?: string;
  applicationOrigins: string[];
  onDone(): void;
}) {
  const [topic, setTopic] = useState<FeedbackTopic>("problem");
  const [message, setMessage] = useState("");
  const [replyEmail, setReplyEmail] = useState("");
  const [includeCollection, setIncludeCollection] = useState(false);
  const [includeApplication, setIncludeApplication] = useState(false);
  const [applicationOrigin, setApplicationOrigin] = useState(applicationOrigins[0] ?? "");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot>();
  const [screenshotPreview, setScreenshotPreview] = useState("");
  const [screenshotError, setScreenshotError] = useState("");
  const [readingScreenshot, setReadingScreenshot] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileAttempt, setTurnstileAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const requestId = useRef(createRequestId());
  const diagnostics = useMemo(() => buildFeedbackDiagnostics(sourceView), [sourceView]);

  useEffect(() => () => {
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
  }, [screenshotPreview]);

  async function chooseScreenshot(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setScreenshot(undefined);
    setScreenshotError("");
    if (!file) return;
    setReadingScreenshot(true);
    try {
      const next = await readFeedbackScreenshot(file);
      setScreenshot(next);
      setScreenshotPreview(URL.createObjectURL(file));
    } catch (reason) {
      event.target.value = "";
      setScreenshotPreview("");
      setScreenshotError(reason instanceof Error ? reason.message : "The screenshot could not be read.");
    } finally {
      setReadingScreenshot(false);
    }
  }

  function removeScreenshot() {
    setScreenshot(undefined);
    setScreenshotPreview("");
    setScreenshotError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanMessage = message.trim();
    if (!cleanMessage || readingScreenshot || (turnstileSiteKey && !turnstileToken)) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await sendFeedback(endpoint, {
        schema_version: 1,
        request_id: requestId.current,
        topic,
        message: cleanMessage,
        ...(replyEmail.trim() ? { reply_email: replyEmail.trim() } : {}),
        ...(includeCollection || includeApplication ? { context: {
          ...(includeCollection && collectionName ? { collection_name: collectionName } : {}),
          ...(includeApplication && applicationOrigin ? { application_origin: applicationOrigin } : {})
        } } : {}),
        ...(includeDiagnostics ? { diagnostics } : {}),
        ...(screenshot ? { screenshot } : {}),
        ...(turnstileToken ? { turnstile_token: turnstileToken } : {})
      });
      setSubmitted(true);
    } catch (reason) {
      if (turnstileSiteKey) {
        setTurnstileToken("");
        setTurnstileAttempt((attempt) => attempt + 1);
      }
      setSubmitError(reason instanceof Error ? reason.message : "Feedback could not be sent. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return <Page title="Feedback sent" intro="Thank you. Your feedback has been delivered for review.">
      <section className="connect-feedback-complete">
        <SectionTitle title="What happens next" />
        <p>Feedback is reviewed, but it may not receive an individual response. Security reports should use the private reporting instructions instead.</p>
        <button className="connect-primary-action" onClick={onDone}>Back to mdbase connect</button>
      </section>
    </Page>;
  }

  return <Page title="Send feedback" intro="Report a problem or share an idea about mdbase connect. Feedback is reviewed by the mdbase team.">
    <form className="connect-feedback-form" onSubmit={(event) => void submit(event)}>
      <section>
        <SectionTitle title="Your feedback" />
        <fieldset className="connect-feedback-topic">
          <legend>What would you like to share?</legend>
          <label><input type="radio" name="feedback-topic" value="problem" checked={topic === "problem"} onChange={() => setTopic("problem")} /><span><strong>Report a problem</strong><small>Something failed or was difficult to understand.</small></span></label>
          <label><input type="radio" name="feedback-topic" value="idea" checked={topic === "idea"} onChange={() => setTopic("idea")} /><span><strong>Share an idea</strong><small>Describe what you would like to accomplish.</small></span></label>
        </fieldset>
        <label className="connect-feedback-field"><span>{topic === "problem" ? "What were you trying to do, and what happened?" : "What would you like to be able to do?"}</span><textarea required maxLength={FEEDBACK_MAX_MESSAGE_LENGTH} rows={8} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
        <span className="connect-feedback-count">{message.length.toLocaleString()} / {FEEDBACK_MAX_MESSAGE_LENGTH.toLocaleString()}</span>
        <label className="connect-feedback-field"><span>Reply email <small>Optional</small></span><input type="email" maxLength={320} autoComplete="email" value={replyEmail} onChange={(event) => setReplyEmail(event.target.value)} placeholder="you@example.com" /></label>
      </section>

      <section>
        <SectionTitle title="Screenshot" note="Optional · one PNG or JPEG · up to 3 MB" />
        <label className="connect-feedback-upload"><input type="file" accept="image/png,image/jpeg" onChange={(event) => void chooseScreenshot(event)} /><span>{readingScreenshot ? "Reading screenshot…" : screenshot ? "Replace screenshot" : "Choose screenshot"}</span></label>
        {screenshotPreview && <div className="connect-feedback-preview"><img src={screenshotPreview} alt="Screenshot preview" /><button type="button" onClick={removeScreenshot}>Remove screenshot</button></div>}
        {screenshotError && <p className="connect-feedback-error" role="alert">{screenshotError}</p>}
        <p className="connect-feedback-help">Review screenshots for information you do not want to share, such as record contents, local paths, or credentials. The image is decoded and re-created before sending to remove embedded metadata.</p>
      </section>

      {(collectionName || applicationOrigins.length > 0) && <section>
        <SectionTitle title="Product context" note="Nothing here is included unless you choose it" />
        <div className="connect-feedback-options">
          {collectionName && <label><input type="checkbox" checked={includeCollection} onChange={(event) => setIncludeCollection(event.target.checked)} /><span>Include collection name: <strong>{collectionName}</strong></span></label>}
          {applicationOrigins.length > 0 && <label><input type="checkbox" checked={includeApplication} onChange={(event) => setIncludeApplication(event.target.checked)} /><span>Include application origin</span></label>}
          {includeApplication && <label className="connect-feedback-origin"><span>Application origin</span><select value={applicationOrigin} onChange={(event) => setApplicationOrigin(event.target.value)}>{applicationOrigins.map((origin) => <option key={origin}>{origin}</option>)}</select></label>}
        </div>
      </section>}

      <section>
        <SectionTitle title="Technical diagnostics" note="Safe, structured information from this browser tab" />
        <label className="connect-feedback-diagnostics-toggle"><input type="checkbox" checked={includeDiagnostics} onChange={(event) => setIncludeDiagnostics(event.target.checked)} /><span>Include technical diagnostics</span></label>
        {includeDiagnostics && <details className="connect-feedback-diagnostics"><summary>Preview diagnostics</summary><pre>{JSON.stringify(diagnostics, null, 2)}</pre></details>}
        <p className="connect-feedback-help">Diagnostics contain product version, browser and operating-system family, viewport class, and recent bounded Connect error codes. They do not include collection contents, request bodies, cookies, tokens, or local paths.</p>
      </section>

      {turnstileSiteKey && <Turnstile key={turnstileAttempt} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />}
      {submitError && <p className="connect-feedback-error" role="alert">{submitError}</p>}
      <div className="connect-feedback-actions"><button type="button" onClick={onDone}>Cancel</button><button className="connect-primary-action" disabled={submitting || readingScreenshot || !message.trim() || Boolean(turnstileSiteKey && !turnstileToken)}>{submitting ? "Sending…" : "Send feedback"}</button></div>
      <p className="connect-feedback-help">Do not use this form for security reports or urgent support.</p>
    </form>
  </Page>;
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
